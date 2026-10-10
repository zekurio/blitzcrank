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
  reasonParam,
  runMutation,
  textResult,
  toolCheck,
  type EvidenceRequirement,
  type HostTool,
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
