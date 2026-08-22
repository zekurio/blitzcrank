import { StringEnum } from "@earendil-works/pi-ai"
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

import type { ServiceConfig } from "../config.ts"
import { HttpError, jsonRequest, type JsonValue } from "../services/http.ts"
import {
  makeReadTool,
  reasonParam,
  runMutation,
  textResult,
  type EvidenceRequirement,
  type ServiceName,
} from "./common.ts"
import type { RunContext } from "./context.ts"

export function arrRequest(
  cfg: ServiceConfig,
  path: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: JsonValue,
): Promise<JsonValue> {
  const options = {
    method,
    headers: { "X-Api-Key": cfg.apiKey },
  }
  if (body !== undefined) Object.assign(options, { body })
  return jsonRequest(cfg.url, path, options)
}

export function arrReadTool(
  service: ServiceName,
  cfg: ServiceConfig,
  ctx: RunContext,
  label: string,
  description: string,
): ToolDefinition {
  return makeReadTool(
    {
      service,
      label,
      description,
      request: (path) => arrRequest(cfg, path),
    },
    ctx,
  )
}

/** Follow-up read on the queued command so the model can see it was accepted. */
async function verifyCommand(
  cfg: ServiceConfig,
  service: ServiceName,
  ctx: RunContext,
  result: JsonValue,
): Promise<JsonValue> {
  const id = isJsonObject(result) && isNumber(result.id) ? result.id : undefined
  if (!id) {
    return {
      warning:
        "command response had no id; verify manually via GET /api/v3/command",
    }
  }
  const path = `/api/v3/command/${id}`
  const status = await arrRequest(cfg, path)
  ctx.recordRead(service, path, JSON.stringify(status))
  return status
}

async function verifyQueue(
  cfg: ServiceConfig,
  service: ServiceName,
  ctx: RunContext,
): Promise<JsonValue> {
  const path = "/api/v3/queue?pageSize=100"
  const queue = await arrRequest(cfg, path)
  ctx.recordRead(service, path, JSON.stringify(queue))
  return queue
}

async function verifyBlocklistAndQueue(
  cfg: ServiceConfig,
  service: ServiceName,
  ctx: RunContext,
): Promise<JsonValue> {
  const path =
    "/api/v3/blocklist?page=1&pageSize=20&sortKey=date&sortDirection=descending"
  const blocklist = await arrRequest(cfg, path)
  ctx.recordRead(service, path, JSON.stringify(blocklist))
  return { blocklist, queue: await verifyQueue(cfg, service, ctx) }
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

async function verifyDeletedFile(
  cfg: ServiceConfig,
  filePath: string,
  fileLabel: string,
): Promise<JsonValue> {
  try {
    const body = await arrRequest(cfg, filePath)
    return { warning: `${fileLabel} still present after delete`, body }
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      return { confirmed: `${fileLabel} no longer present (HTTP 404)` }
    }
    throw err
  }
}

/** ManualImport is shared because both Arrs use the same command shape. */
export function manualImportTool(
  service: ServiceName,
  cfg: ServiceConfig,
  ctx: RunContext,
): ToolDefinition {
  return defineTool({
    name: `${service}_manual_import`,
    label: `${service}: manual import`,
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
    async execute(_toolCallId, params) {
      const evidence = manualImportEvidence(service, params.files)
      const outcome = await runArrCommand(cfg, service, ctx, evidence, {
        name: "ManualImport",
        files: params.files,
        importMode: params.importMode,
      })
      return textResult(outcome, {
        service,
        action: "manual_import",
        files: params.files.length,
      })
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
): ToolDefinition[] {
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

function deleteQueueItemTool(deps: ArrToolDeps): ToolDefinition {
  return defineTool({
    name: `${deps.service}_delete_queue_item`,
    label: `${deps.service}: remove queue item`,
    description: `Remove a stuck/failed download from the ${deps.service} queue, optionally blocklisting the release and removing it from the download client. With removeFromClient=true the downloaded data is destroyed and the call is recorded as a deletion. The queue item id must come from a queue read on this issue.`,
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
    async execute(_toolCallId, params) {
      return executeQueueMutation(
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
    },
  })
}

function blocklistFromHistoryTool(deps: ArrToolDeps): ToolDefinition {
  return defineTool({
    name: `${deps.service}_blocklist_from_history`,
    label: `${deps.service}: blocklist a past grab`,
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
    async execute(_toolCallId, params) {
      const outcome = await runMutation(deps.ctx, {
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
        verify: () => verifyBlocklistAndQueue(deps.cfg, deps.service, deps.ctx),
      })
      return textResult(outcome, {
        service: deps.service,
        action: "blocklist_from_history",
        historyId: params.historyId,
      })
    },
  })
}

function grabQueueItemTool(deps: ArrToolDeps): ToolDefinition {
  return defineTool({
    name: `${deps.service}_grab_queue_item`,
    label: `${deps.service}: force-grab queue item`,
    description: `Force ${deps.service} to grab a pending/delayed queue item now. The queue item id must come from a queue read this run.`,
    parameters: Type.Object({
      reason: reasonParam(),
      queueId: Type.Integer({ minimum: 1 }),
    }),
    async execute(_toolCallId, params) {
      return executeQueueMutation(
        deps,
        params.queueId,
        "grab_queue_item",
        "mutate",
        () =>
          arrRequest(deps.cfg, `/api/v3/queue/grab/${params.queueId}`, "POST"),
      )
    },
  })
}

function removeFromBlocklistTool(deps: ArrToolDeps): ToolDefinition {
  return defineTool({
    name: `${deps.service}_remove_from_blocklist`,
    label: `${deps.service}: remove blocklist entry`,
    description: `Remove one entry from the ${deps.service} blocklist so that release can be grabbed again. The blocklist entry id must come from a blocklist read this run.`,
    parameters: Type.Object({
      reason: reasonParam(),
      blocklistId: Type.Integer({ minimum: 1 }),
    }),
    async execute(_toolCallId, params) {
      const outcome = await runMutation(deps.ctx, {
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
    },
  })
}

async function executeQueueMutation(
  deps: ArrToolDeps,
  queueId: number,
  action: string,
  kind: "mutate" | "delete",
  perform: () => Promise<JsonValue>,
) {
  const outcome = await runMutation(deps.ctx, {
    kind,
    evidence: queueEvidence(deps.service, queueId),
    perform,
    verify: () => verifyQueue(deps.cfg, deps.service, deps.ctx),
  })
  return textResult(outcome, { service: deps.service, action, queueId })
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
