import { StringEnum } from "@earendil-works/pi-ai"
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

import type { ServiceConfig } from "../config.ts"
import { jsonRequest, type JsonValue } from "../services/http.ts"
import { makeReadTool, reasonParam, runMutation, textResult } from "./common.ts"
import type { RunContext } from "./context.ts"
import { assertSabReadAllowed } from "./safety.ts"

type SabMode = "queue" | "history"
type SabCall = (params: Record<string, string>) => Promise<JsonValue>
type VerifyList = (mode: SabMode) => Promise<JsonValue>

interface JobAction {
  name: "retry" | "pause" | "resume"
  label: string
  description: string
  params: (nzoId: string) => Record<string, string>
  verifyMode: SabMode
  idDescription?: string | undefined
}

export function buildSabnzbdTools(
  cfg: ServiceConfig,
  ctx: RunContext,
): ToolDefinition[] {
  const sabCall = createSabCall(cfg)
  const verifyList = createListVerifier(ctx, sabCall)
  return [
    sabReadTool(cfg, ctx),
    jobActionTool(ctx, sabCall, verifyList, {
      name: "retry",
      label: "SABnzbd: retry failed job",
      description:
        "Retry one failed SABnzbd history job (moves it back to the queue). Only after the failure cause is understood/fixed. The nzo_id must come from a SABnzbd read this run.",
      params: (nzoId) => ({ mode: "retry", value: nzoId }),
      verifyMode: "queue",
      idDescription: "SABnzbd nzo_id of the failed history job",
    }),
    deleteJobTool(ctx, sabCall, verifyList),
    jobActionTool(ctx, sabCall, verifyList, {
      name: "pause",
      label: "SABnzbd: pause job",
      description:
        "Pause one SABnzbd queue job. The nzo_id must come from a SABnzbd read this run.",
      params: (nzoId) => ({ mode: "queue", name: "pause", value: nzoId }),
      verifyMode: "queue",
    }),
    jobActionTool(ctx, sabCall, verifyList, {
      name: "resume",
      label: "SABnzbd: resume job",
      description:
        "Resume one paused SABnzbd queue job. The nzo_id must come from a SABnzbd read this run.",
      params: (nzoId) => ({ mode: "queue", name: "resume", value: nzoId }),
      verifyMode: "queue",
    }),
  ]
}

function createSabCall(cfg: ServiceConfig): SabCall {
  return (params) => {
    const url = new URL(cfg.url + "/api")
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }
    url.searchParams.set("apikey", cfg.apiKey)
    url.searchParams.set("output", "json")
    return jsonRequest(url.origin, url.pathname + url.search, {})
  }
}

function createListVerifier(ctx: RunContext, sabCall: SabCall): VerifyList {
  return async (mode) => {
    const list = await sabCall({ mode, limit: "50" })
    ctx.recordRead(
      "sabnzbd",
      `/api?mode=${mode}&limit=50`,
      JSON.stringify(list),
    )
    return list
  }
}

function sabReadTool(cfg: ServiceConfig, ctx: RunContext): ToolDefinition {
  return makeReadTool(
    {
      service: "sabnzbd",
      label: "SABnzbd read",
      description:
        "Read SABnzbd state: only /api?mode=queue and /api?mode=history (plus limit=N). Job control goes through the dedicated sabnzbd_* tools.",
      guards: (path) => {
        if (!path.startsWith("/api")) {
          throw new Error("SABnzbd path must start with /api")
        }
        assertSabReadAllowed(path)
      },
      request: (path) => sabRead(cfg, path),
    },
    ctx,
  )
}

function sabRead(cfg: ServiceConfig, path: string): Promise<JsonValue> {
  const url = new URL(cfg.url + path)
  url.searchParams.set("apikey", cfg.apiKey)
  url.searchParams.set("output", "json")
  return jsonRequest(url.origin, url.pathname + url.search, {})
}

function jobActionTool(
  ctx: RunContext,
  sabCall: SabCall,
  verifyList: VerifyList,
  action: JobAction,
): ToolDefinition {
  const nzoId = action.idDescription
    ? Type.String({ minLength: 1, description: action.idDescription })
    : Type.String({ minLength: 1 })
  return defineTool({
    name: `sabnzbd_${action.name}_job`,
    label: action.label,
    description: action.description,
    parameters: Type.Object({
      reason: reasonParam(),
      nzoId,
    }),
    async execute(_toolCallId, params) {
      const outcome = await runMutation(ctx, {
        kind: "mutate",
        evidence: nzoEvidence(params.nzoId),
        perform: () => sabCall(action.params(params.nzoId)),
        verify: () => verifyList(action.verifyMode),
      })
      return textResult(outcome, {
        service: "sabnzbd",
        action: `${action.name}_job`,
        nzoId: params.nzoId,
      })
    },
  })
}

function deleteJobTool(
  ctx: RunContext,
  sabCall: SabCall,
  verifyList: VerifyList,
): ToolDefinition {
  return defineTool({
    name: "sabnzbd_delete_job",
    label: "SABnzbd: delete job",
    description:
      "Remove one job from the SABnzbd queue or history. deleteFiles=true also deletes downloaded data and is recorded as a deletion. Prefer Arr-level queue removal when the Arr still tracks the item; never orphan an Arr that is waiting on this job. The nzo_id must come from a SABnzbd read on this issue.",
    parameters: Type.Object({
      reason: reasonParam(),
      nzoId: Type.String({ minLength: 1 }),
      from: StringEnum(["queue", "history"] as const),
      deleteFiles: Type.Boolean({
        description:
          "Also delete downloaded data from disk (counts as a deletion)",
      }),
    }),
    async execute(_toolCallId, params) {
      const outcome = await runMutation(ctx, {
        kind: params.deleteFiles ? "delete" : "mutate",
        evidence: nzoEvidence(params.nzoId),
        perform: () =>
          sabCall({
            mode: params.from,
            name: "delete",
            value: params.nzoId,
            del_files: params.deleteFiles ? "1" : "0",
          }),
        verify: () => verifyList(params.from),
      })
      return textResult(outcome, {
        service: "sabnzbd",
        action: "delete_job",
        from: params.from,
        nzoId: params.nzoId,
      })
    },
  })
}

function nzoEvidence(nzoId: string) {
  return [{ service: "sabnzbd" as const, value: nzoId, hint: "nzo_id" }]
}
