import { StringEnum } from "@earendil-works/pi-ai"
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
  makeReadTool,
  MAX_RESULT_CHARS,
  reasonParam,
  runMutation,
  textResult,
  toolCheck,
  toText,
  type EvidenceRequirement,
  type ServiceName,
  type ToolError,
} from "./common.ts"
import type { RunContext } from "./context.ts"

export function arrRequest(
  cfg: ServiceConfig,
  path: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: JsonValue,
): Effect.Effect<JsonValue, JsonRequestError> {
  const options = {
    method,
    headers: { "X-Api-Key": cfg.apiKey },
  }
  if (body !== undefined) Object.assign(options, { body })
  return jsonRequestEffect(cfg.url, path, options)
}

export function arrReadTool(
  service: ServiceName,
  cfg: ServiceConfig,
  ctx: RunContext,
  label: string,
  description: string,
): ToolRegistration {
  return makeReadTool(
    {
      service,
      label,
      description,
      guards: (path) => assertNotReleaseSearch(service, path),
      request: (path) => arrRequest(cfg, path),
    },
    ctx,
  )
}

/**
 * A raw release search returns every indexer hit in full, so the result cap
 * leaves only the first few candidates. That partial list once read as "no
 * replacement exists" while matching releases sat further down.
 */
function assertNotReleaseSearch(service: ServiceName, path: string): void {
  const pathname = new URL(path, "http://127.0.0.1").pathname.toLowerCase()
  if (pathname === "/api/v3/release" || pathname === "/api/v3/release/") {
    throw new Error(
      `read release candidates with ${service}_releases; it counts every hit and filters the listing`,
    )
  }
}

/** Release searches wait on every indexer; the default 30s is too short. */
const RELEASE_TIMEOUT_MS = 120_000
const DEFAULT_RELEASE_LIMIT = 20
const MAX_REJECTION_GROUPS = 8

export type JsonObject = { [key: string]: JsonValue | undefined }

export interface ReleaseFilters {
  publishedAfter?: string | undefined
  titleContains?: string | undefined
  approvedOnly?: boolean | undefined
  limit?: number | undefined
}

export interface ReleaseTarget {
  path: string
  /** Whether the Arr mapped this release to the requested item. */
  matches: (release: JsonObject) => boolean
  /** Service-specific mapping fields for one listed release. */
  describe?: (release: JsonObject) => JsonObject
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
 * capped listing in the Arr's own preference order. Releases the Arr mapped to
 * another item are only counted: an episode search also returns other
 * episodes' releases, which buried the requested ones.
 */
export function readReleases(
  service: ServiceName,
  cfg: ServiceConfig,
  ctx: RunContext,
  target: ReleaseTarget,
  filters: ReleaseFilters,
): Effect.Effect<JsonObject, JsonRequestError | ToolError> {
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
function fitListing(summary: JsonObject, listed: JsonObject[]): JsonObject {
  const withCount = (count: number): JsonObject => ({
    ...summary,
    listed: count,
    releases: listed.slice(0, count),
  })
  const fits = listed
    .map((_, index) => listed.length - index)
    .find((count) => toText(withCount(count)).length <= MAX_RESULT_CHARS)
  return withCount(fits ?? 0)
}

function matchesFilters(release: JsonObject, filters: ReleaseFilters): boolean {
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

function compactRelease(release: JsonObject): JsonObject {
  const quality = objectField(objectField(release, "quality"), "quality")
  const rejections = stringList(release.rejections)
  return {
    title: release.title ?? null,
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

function rejectionGroups(releases: JsonObject[]): JsonValue[] {
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
  value: JsonObject | undefined,
  key: string,
): JsonObject | undefined {
  const field = value?.[key]
  return field !== undefined && isJsonObject(field) ? field : undefined
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
  service: ServiceName,
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
  service: ServiceName,
  ctx: RunContext,
): Effect.Effect<JsonValue, JsonRequestError> {
  return Effect.gen(function* () {
    const path = "/api/v3/queue?pageSize=100"
    const queue = yield* arrRequest(cfg, path)
    ctx.recordRead(service, path, JSON.stringify(queue))
    return queue
  })
}

function verifyBlocklistAndQueue(
  cfg: ServiceConfig,
  service: ServiceName,
  ctx: RunContext,
): Effect.Effect<JsonValue, JsonRequestError> {
  return Effect.gen(function* () {
    const path =
      "/api/v3/blocklist?page=1&pageSize=20&sortKey=date&sortDirection=descending"
    const blocklist = yield* arrRequest(cfg, path)
    ctx.recordRead(service, path, JSON.stringify(blocklist))
    return { blocklist, queue: yield* verifyQueue(cfg, service, ctx) }
  })
}

export function runArrCommand(
  cfg: ServiceConfig,
  service: ServiceName,
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
  service: ServiceName,
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

/** ManualImport is shared because both Arrs use the same command shape. */
export function manualImportTool(
  service: ServiceName,
  cfg: ServiceConfig,
  ctx: RunContext,
): ToolRegistration {
  return defineTool({
    name: `${service}_manual_import`,
    description:
      `Run ${service}'s ManualImport command for verified candidates from a GET /api/v3/manualimport read this run. ` +
      "Trim each candidate to the fields the command needs " +
      (service === "sonarr"
        ? "(path, folderName, seriesId, episodeIds, quality, languages, releaseGroup); use importMode move."
        : "(path, folderName, movieId, quality, languages, releaseGroup); use importMode auto."),
    parameters: Type.Object({
      reason: reasonParam(),
      files: Type.Array(Type.Record(Type.String(), Type.Any()), {
        minItems: 1,
        description:
          "Candidate objects from the manualimport read, trimmed to required fields",
      }),
      importMode: StringEnum(["auto", "move", "copy"] as const),
    }),
    execute(params) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const evidence = yield* toolCheck(() =>
            manualImportEvidence(service, params.files),
          )
          const outcome = yield* runArrCommand(cfg, service, ctx, evidence, {
            name: "ManualImport",
            files: params.files,
            importMode: params.importMode,
          })
          return textResult(outcome, {
            service,
            action: "manual_import",
            files: params.files.length,
          })
        }),
      )
    },
  })
}

function manualImportEvidence(
  service: ServiceName,
  files: Array<Record<string, JsonValue | undefined>>,
): EvidenceRequirement[] {
  return files.flatMap((file) => {
    if (!isString(file.path) || file.path.length === 0) {
      throw new Error(
        "every manual import file needs the candidate's path field",
      )
    }
    const ids = [
      file.seriesId,
      file.movieId,
      ...(Array.isArray(file.episodeIds) ? file.episodeIds : []),
    ].filter((id): id is number => typeof id === "number")
    return [
      { service, value: file.path, hint: "candidate path" },
      ...ids.map((id) => ({
        service,
        value: id,
        hint: "candidate target id",
      })),
    ]
  })
}

export function queueAndBlocklistTools(
  service: ServiceName,
  cfg: ServiceConfig,
  ctx: RunContext,
): ToolRegistration[] {
  const deps = { service, cfg, ctx }
  return [
    deleteQueueItemTool(deps),
    blocklistFromHistoryTool(deps),
    grabQueueItemTool(deps),
    removeFromBlocklistTool(deps),
  ]
}

interface ArrToolDeps {
  service: ServiceName
  cfg: ServiceConfig
  ctx: RunContext
}

function deleteQueueItemTool(deps: ArrToolDeps): ToolRegistration {
  return defineTool({
    name: `${deps.service}_delete_queue_item`,
    description: `Remove a stuck/failed download from the ${deps.service} queue, optionally blocklisting the release and removing it from the download client. With removeFromClient=true the downloaded data is destroyed and the call is recorded as a deletion. The queue item id must pass the ${deps.service} evidence gate.`,
    parameters: Type.Object({
      reason: reasonParam(),
      queueId: Type.Integer({ minimum: 1 }),
      blocklist: Type.Boolean({
        description:
          "Blocklist the release so it is not grabbed again (default true)",
      }),
      removeFromClient: Type.Boolean({
        description:
          "Also remove the job from the download client, destroying the downloaded data (default true)",
      }),
    }),
    execute(params) {
      return Effect.runPromise(
        Effect.gen(function* () {
          return yield* executeQueueMutation(
            deps,
            params.queueId,
            "delete_queue_item",
            params.removeFromClient ? "delete" : "mutate",
            () =>
              arrRequest(
                deps.cfg,
                `/api/v3/queue/${params.queueId}?removeFromClient=${params.removeFromClient}&blocklist=${params.blocklist}`,
                "DELETE",
              ),
          )
        }),
      )
    },
  })
}

function blocklistFromHistoryTool(deps: ArrToolDeps): ToolRegistration {
  return defineTool({
    name: `${deps.service}_blocklist_from_history`,
    description:
      `Blocklist the release behind one ${deps.service} history record, so it is never grabbed again. Marks that grab as failed ` +
      `(POST /api/v3/history/failed/{id}), which is the only way to exclude a release that has left the queue. Use this on ` +
      `the bad release when replacing a wrong or corrupt file: unblocked, it usually still scores highest and a plain ` +
      `search just grabs it again. Two consequences to plan for: with the Arr's default autoRedownloadFailed it also ` +
      `starts its own replacement search, so do not follow it with a separate search call — read the queue instead and ` +
      `check which release it picked; and if that grab is still active in the download client it will be discarded, so ` +
      `point this at a grab that is finished, not at the download you are waiting on. The history record id must come ` +
      `from a ${deps.service} history read this run.`,
    parameters: Type.Object({
      reason: reasonParam(),
      historyId: Type.Integer({ minimum: 1 }),
    }),
    execute(params) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const outcome = yield* runMutation(deps.ctx, {
            kind: "mutate",
            evidence: [
              {
                service: deps.service,
                value: params.historyId,
                hint: "history record id",
              },
            ],
            perform: () =>
              arrRequest(
                deps.cfg,
                `/api/v3/history/failed/${params.historyId}`,
                "POST",
              ),
            verify: () =>
              verifyBlocklistAndQueue(deps.cfg, deps.service, deps.ctx),
          })
          return textResult(outcome, {
            service: deps.service,
            action: "blocklist_from_history",
            historyId: params.historyId,
          })
        }),
      )
    },
  })
}

function grabQueueItemTool(deps: ArrToolDeps): ToolRegistration {
  return defineTool({
    name: `${deps.service}_grab_queue_item`,
    description: `Force ${deps.service} to grab a pending/delayed queue item now. The queue item id must come from a queue read this run.`,
    parameters: Type.Object({
      reason: reasonParam(),
      queueId: Type.Integer({ minimum: 1 }),
    }),
    execute(params) {
      return Effect.runPromise(
        Effect.gen(function* () {
          return yield* executeQueueMutation(
            deps,
            params.queueId,
            "grab_queue_item",
            "mutate",
            () =>
              arrRequest(
                deps.cfg,
                `/api/v3/queue/grab/${params.queueId}`,
                "POST",
              ),
          )
        }),
      )
    },
  })
}

function removeFromBlocklistTool(deps: ArrToolDeps): ToolRegistration {
  return defineTool({
    name: `${deps.service}_remove_from_blocklist`,
    description: `Remove one entry from the ${deps.service} blocklist so that release can be grabbed again. The blocklist entry id must come from a blocklist read this run.`,
    parameters: Type.Object({
      reason: reasonParam(),
      blocklistId: Type.Integer({ minimum: 1 }),
    }),
    execute(params) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const outcome = yield* runMutation(deps.ctx, {
            kind: "mutate",
            evidence: [
              {
                service: deps.service,
                value: params.blocklistId,
                hint: "blocklist entry id",
              },
            ],
            perform: () =>
              arrRequest(
                deps.cfg,
                `/api/v3/blocklist/${params.blocklistId}`,
                "DELETE",
              ),
          })
          return textResult(outcome, {
            service: deps.service,
            action: "remove_from_blocklist",
            blocklistId: params.blocklistId,
          })
        }),
      )
    },
  })
}

function executeQueueMutation(
  deps: ArrToolDeps,
  queueId: number,
  action: string,
  kind: "mutate" | "delete",
  perform: () => Effect.Effect<JsonValue, JsonRequestError>,
) {
  return Effect.gen(function* () {
    const outcome = yield* runMutation(deps.ctx, {
      kind,
      evidence: queueEvidence(deps.service, queueId),
      perform,
      verify: () => verifyQueue(deps.cfg, deps.service, deps.ctx),
    })
    return textResult(outcome, { service: deps.service, action, queueId })
  })
}

function queueEvidence(
  service: ServiceName,
  queueId: number,
): EvidenceRequirement[] {
  return [{ service, value: queueId, hint: "queue item id" }]
}

function isJsonObject(
  value: JsonValue,
): value is { [key: string]: JsonValue | undefined } {
  return value !== null && Object(value) === value && !Array.isArray(value)
}

function isNumber<Value>(value: Value): value is Value & number {
  return typeof value === "number"
}

function isString<Value>(value: Value): value is Value & string {
  return typeof value === "string"
}
