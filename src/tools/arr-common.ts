import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable"
import { Effect } from "effect"
import { Type } from "typebox"

import type { ServiceConfig } from "../config.ts"
import {
  jsonRequestEffect,
  type JsonRequestError,
  type JsonValue,
} from "../services/http.ts"
import {
  makeRequestTool,
  MAX_RESULT_CHARS,
  reasonParam,
  runMutation,
  textResult,
  toolCheck,
  toText,
  type EvidenceRequirement,
  type HostTool,
  type ToolError,
} from "./common.ts"
import type { RunContext } from "./context.ts"
import { arrRoute, type Method } from "./safety.ts"

type ArrService = "sonarr" | "radarr"

export function arrRequest(
  cfg: ServiceConfig,
  path: string,
  method: Method = "GET",
  body?: JsonValue,
): Effect.Effect<JsonValue, JsonRequestError> {
  const options = {
    method,
    headers: { "X-Api-Key": cfg.apiKey },
  }
  if (body !== undefined) Object.assign(options, { body })
  return jsonRequestEffect(cfg.url, path, options)
}

export function arrRequestTool(
  service: ArrService,
  cfg: ServiceConfig,
  ctx: RunContext,
  description: string,
): HostTool {
  return makeRequestTool(
    {
      service,
      description,
      methods: ["GET", "POST", "PUT", "DELETE"],
      route: (method, path, body) => arrRoute(service, method, path, body),
      request: (method, path, body) => arrRequest(cfg, path, method, body),
    },
    ctx,
  )
}

/** Release searches wait on every indexer; the default 30s is too short. */
const RELEASE_TIMEOUT_MS = 120_000
const DEFAULT_RELEASE_LIMIT = 20
const MAX_REJECTION_GROUPS = 8

export interface ReleaseFilters {
  publishedAfter?: string | undefined
  titleContains?: string | undefined
  approvedOnly?: boolean | undefined
  limit?: number | undefined
}

export interface ReleaseTarget {
  path: string
  /** Whether the Arr mapped this release to the requested item. */
  matches: (release: ArrRecord) => boolean
  /** Service-specific mapping fields for one listed release. */
  describe?: (release: ArrRecord) => ArrRecord
}

export const releaseFilterParams = () => ({
  purpose: Type.String({
    description: "What evidence this candidate read should produce",
  }),
  publishedAfter: Type.Optional(
    Type.String({
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description: "List only releases published on or after this UTC date",
    }),
  ),
  titleContains: Type.Optional(
    Type.String({
      minLength: 1,
      description: "List only releases whose title contains this text",
    }),
  ),
  approvedOnly: Type.Optional(
    Type.Boolean({ description: "List only releases the Arr would grab" }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 50,
      description: `How many releases to list (default ${DEFAULT_RELEASE_LIMIT})`,
    }),
  ),
})

/**
 * Runs one release search and returns counts over every hit plus a filtered,
 * capped listing in the Arr's own preference order. A raw release search
 * returns every indexer hit in full, so the result cap left only the first few
 * candidates, which once read as "no replacement exists". Releases the Arr
 * mapped to another item are only counted: an episode search also returns
 * other episodes' releases, which buried the requested ones.
 */
export function readReleases(
  service: ArrService,
  cfg: ServiceConfig,
  ctx: RunContext,
  target: ReleaseTarget,
  filters: ReleaseFilters,
): Effect.Effect<ArrRecord, JsonRequestError | ToolError> {
  return Effect.gen(function* () {
    const raw = yield* jsonRequestEffect(cfg.url, target.path, {
      headers: { "X-Api-Key": cfg.apiKey },
      timeoutMs: RELEASE_TIMEOUT_MS,
    })
    const releases = yield* toolCheck(() => {
      if (!Array.isArray(raw)) {
        throw new Error(`${service} returned no release list`)
      }
      return raw.filter(isJsonObject)
    })
    const forTarget = releases.filter(target.matches)
    const elsewhere = releases.filter((release) => !target.matches(release))
    const matching = forTarget.filter((release) =>
      matchesFilters(release, filters),
    )
    const listed = matching
      .slice(0, filters.limit ?? DEFAULT_RELEASE_LIMIT)
      .map((release) => ({
        ...compactRelease(release),
        ...target.describe?.(release),
      }))
    const result = fitListing(
      {
        total: releases.length,
        forTarget: forTarget.length,
        approvedForTarget: forTarget.filter(
          (release) => release.approved === true,
        ).length,
        matchingFilters: matching.length,
        rejectionsInMatching: rejectionGroups(matching),
        otherTargets: {
          count: elsewhere.length,
          examples: elsewhere
            .slice(0, 5)
            .map((release) => release.title ?? null),
        },
      },
      listed,
    )
    ctx.recordRead(service, target.path, JSON.stringify(result))
    return result
  })
}

/**
 * Drops trailing entries until the result fits one tool result. A cut listing
 * would be invalid JSON and lose the entries' closing fields.
 */
function fitListing(summary: ArrRecord, listed: ArrRecord[]): ArrRecord {
  const withCount = (count: number): ArrRecord => ({
    ...summary,
    listed: count,
    releases: listed.slice(0, count),
  })
  const fits = listed
    .map((_, index) => listed.length - index)
    .find((count) => toText(withCount(count)).length <= MAX_RESULT_CHARS)
  return withCount(fits ?? 0)
}

function matchesFilters(release: ArrRecord, filters: ReleaseFilters): boolean {
  if (filters.approvedOnly === true && release.approved !== true) return false
  if (
    filters.publishedAfter !== undefined &&
    !(
      isString(release.publishDate) &&
      release.publishDate.slice(0, 10) >= filters.publishedAfter
    )
  ) {
    return false
  }
  if (filters.titleContains === undefined) return true
  return (
    isString(release.title) &&
    release.title.toLowerCase().includes(filters.titleContains.toLowerCase())
  )
}

/** `guid` and `indexerId` are what `POST /api/v3/release` grabs by. */
function compactRelease(release: ArrRecord): ArrRecord {
  const quality = objectField(objectField(release, "quality"), "quality")
  const rejections = stringList(release.rejections)
  return {
    title: release.title ?? null,
    guid: release.guid ?? null,
    indexerId: release.indexerId ?? null,
    published: isString(release.publishDate)
      ? release.publishDate.slice(0, 10)
      : null,
    indexer: release.indexer ?? null,
    protocol: release.protocol ?? null,
    sizeMb: isNumber(release.size)
      ? Math.round(release.size / 1_000_000)
      : null,
    quality: quality?.name ?? null,
    languages: names(release.languages),
    customFormatScore: release.customFormatScore ?? null,
    customFormats: names(release.customFormats),
    approved: release.approved === true,
    ...(rejections.length > 0 ? { rejections } : {}),
  }
}

function rejectionGroups(releases: ArrRecord[]): JsonValue[] {
  const counts = new Map<string, number>()
  for (const reason of releases.flatMap((release) =>
    stringList(release.rejections),
  )) {
    counts.set(reason, (counts.get(reason) ?? 0) + 1)
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_REJECTION_GROUPS)
    .map(([reason, count]) => ({ reason, count }))
}

function objectField(
  value: ArrRecord | undefined,
  key: string,
): ArrRecord | undefined {
  const field = value?.[key]
  return isJsonObject(field) ? field : undefined
}

function names(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) =>
    isJsonObject(item) && isString(item.name) ? [item.name] : [],
  )
}

function stringList(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter(isString) : []
}

/** Follow-up read on the queued command so the model can see it was accepted. */
function verifyCommand(
  cfg: ServiceConfig,
  service: ArrService,
  ctx: RunContext,
  result: JsonValue,
): Effect.Effect<JsonValue, JsonRequestError> {
  return Effect.gen(function* () {
    const id =
      isJsonObject(result) && isNumber(result.id) ? result.id : undefined
    if (!id) {
      return {
        warning:
          "command response had no id; verify manually via GET /api/v3/command",
      }
    }
    const path = `/api/v3/command/${id}`
    const status = yield* arrRequest(cfg, path)
    ctx.recordRead(service, path, JSON.stringify(status))
    return status
  })
}

function verifyQueue(
  cfg: ServiceConfig,
  service: ArrService,
  ctx: RunContext,
): Effect.Effect<JsonValue, JsonRequestError> {
  return Effect.gen(function* () {
    const path = "/api/v3/queue?pageSize=100"
    const queue = yield* arrRequest(cfg, path)
    ctx.recordRead(service, path, JSON.stringify(queue))
    return queue
  })
}

export function runArrCommand(
  cfg: ServiceConfig,
  service: ArrService,
  ctx: RunContext,
  evidence: EvidenceRequirement[],
  body: JsonValue,
) {
  return runMutation(ctx, {
    kind: "mutate",
    evidence,
    perform: () => arrRequest(cfg, "/api/v3/command", "POST", body),
    verify: (result) => verifyCommand(cfg, service, ctx, result),
  })
}

export function runArrFileDelete(
  cfg: ServiceConfig,
  service: ArrService,
  ctx: RunContext,
  filePath: string,
  fileId: number,
  evidenceHint: string,
  fileLabel: string,
) {
  return runMutation(ctx, {
    kind: "delete",
    evidence: [{ service, value: fileId, hint: evidenceHint }],
    perform: () => arrRequest(cfg, filePath, "DELETE"),
    verify: () => verifyDeletedFile(cfg, filePath, fileLabel),
  })
}

function verifyDeletedFile(
  cfg: ServiceConfig,
  filePath: string,
  fileLabel: string,
): Effect.Effect<JsonValue, JsonRequestError> {
  return arrRequest(cfg, filePath).pipe(
    Effect.map(
      (body): JsonValue => ({
        warning: `${fileLabel} still present after delete`,
        body,
      }),
    ),
    Effect.catchTag("HttpError", (error) =>
      error.status === 404
        ? Effect.succeed({
            confirmed: `${fileLabel} no longer present (HTTP 404)`,
          })
        : Effect.fail(error),
    ),
  )
}

export type ArrRecord = { [key: string]: JsonValue | undefined }

export interface MonitoringUpdate {
  /** The record's own path, e.g. `/api/v3/series/12`. */
  path: string
  id: number
  hint: string
  /** External identity that a body without it would reset to 0. */
  identity: "tvdbId" | "tmdbId"
  /** Fields that must read back exactly as they were sent. */
  preserved: readonly string[]
  /** Applies the requested monitoring to a copy; throws on an invalid request. */
  patch: (record: ArrRecord) => ArrRecord
  /** The monitoring fields the read-back must match. */
  monitoring: (record: ArrRecord) => JsonValue
}

/**
 * Arr PUT replaces the whole record: an omitted field deserializes to its
 * default (identity 0, no seasons, no path). So read the current record,
 * change only monitoring, and send everything else back as read.
 */
export function runArrMonitoringUpdate(
  cfg: ServiceConfig,
  service: ArrService,
  ctx: RunContext,
  update: MonitoringUpdate,
) {
  return Effect.gen(function* () {
    yield* toolCheck(() => ctx.requireEvidence(service, update.id, update.hint))
    const current = yield* arrRequest(cfg, update.path)
    const body = yield* toolCheck(() => {
      const record = arrRecord(current, update)
      ctx.recordRead(service, update.path, JSON.stringify(record))
      return update.patch(record)
    })
    return yield* runMutation(ctx, {
      kind: "mutate",
      perform: () => arrRequest(cfg, update.path, "PUT", body),
      verify: () =>
        Effect.gen(function* () {
          const after = yield* arrRequest(cfg, update.path)
          return yield* toolCheck(() => {
            const record = arrRecord(after, update)
            ctx.recordRead(service, update.path, JSON.stringify(record))
            return monitoringReadBack(record, body, update)
          })
        }),
    })
  })
}

function arrRecord(
  value: JsonValue | undefined,
  update: MonitoringUpdate,
): ArrRecord {
  if (!isJsonObject(value) || value.id !== update.id) {
    throw new Error(
      `${update.hint} ${update.id} did not read back as that record`,
    )
  }
  const identity = value[update.identity]
  if (
    !isNumber(identity) ||
    identity < 1 ||
    typeof value.path !== "string" ||
    value.path === "" ||
    !isNumber(value.qualityProfileId) ||
    typeof value.monitored !== "boolean"
  ) {
    // Sending such a record back could reset the missing fields.
    throw new Error(
      `${update.hint} ${update.id} read back without a valid ${update.identity}, path, ` +
        "qualityProfileId, or monitored",
    )
  }
  return value
}

function monitoringReadBack(
  record: ArrRecord,
  sent: ArrRecord,
  update: MonitoringUpdate,
): JsonValue {
  const monitoring = update.monitoring(record)
  const changed = update.preserved.filter(
    (field) => JSON.stringify(record[field]) !== JSON.stringify(sent[field]),
  )
  if (
    changed.length === 0 &&
    JSON.stringify(monitoring) === JSON.stringify(update.monitoring(sent))
  ) {
    return {
      confirmed: "monitoring applied; other fields unchanged",
      monitoring,
    }
  }
  return {
    warning:
      changed.length > 0
        ? `read-back differs in ${changed.join(", ")}`
        : "read-back monitoring differs from the request",
    monitoring,
  }
}

/** Removing a queue item from the download client destroys its data. */
export function deleteQueueItemTool(
  service: ArrService,
  cfg: ServiceConfig,
  ctx: RunContext,
): ToolRegistration {
  return defineTool({
    name: `${service}_delete_queue_item`,
    description:
      `Remove a download from the ${service} queue and from the download client, destroying the downloaded ` +
      `data. To drop only the queue entry and keep the data, use ${service}_request with ` +
      `DELETE /api/v3/queue/{id}?removeFromClient=false. The queue item id must pass the ${service} evidence gate.`,
    parameters: Type.Object({
      reason: reasonParam(),
      queueId: Type.Integer({ minimum: 1 }),
      blocklist: Type.Boolean({
        description: "Blocklist the release so it is not grabbed again",
      }),
    }),
    execute(params) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const outcome = yield* runMutation(ctx, {
            kind: "delete",
            evidence: [
              { service, value: params.queueId, hint: "queue item id" },
            ],
            perform: () =>
              arrRequest(
                cfg,
                `/api/v3/queue/${params.queueId}?removeFromClient=true&blocklist=${params.blocklist}`,
                "DELETE",
              ),
            verify: () => verifyQueue(cfg, service, ctx),
          })
          return textResult(outcome, {
            service,
            action: "delete_queue_item",
            queueId: params.queueId,
          })
        }),
      )
    },
  })
}

function isJsonObject(
  value: JsonValue | undefined,
): value is { [key: string]: JsonValue | undefined } {
  return (
    value !== undefined &&
    value !== null &&
    Object(value) === value &&
    !Array.isArray(value)
  )
}

function isNumber<Value>(value: Value): value is Value & number {
  return typeof value === "number"
}

function isString<Value>(value: Value): value is Value & string {
  return typeof value === "string"
}
