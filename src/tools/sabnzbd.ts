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
  makeRequestTool,
  reasonParam,
  runMutation,
  textResult,
  type HostTool,
} from "./common.ts"
import type { RunContext } from "./context.ts"
import { sabRoute } from "./safety.ts"

type SabCall = (
  params: Record<string, string>,
) => Effect.Effect<JsonValue, JsonRequestError>

export function buildSabnzbdTools(
  cfg: ServiceConfig,
  ctx: RunContext,
): HostTool[] {
  const sabCall: SabCall = (params) => {
    const url = new URL(cfg.url + "/api")
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }
    url.searchParams.set("apikey", cfg.apiKey)
    url.searchParams.set("output", "json")
    return jsonRequestEffect(url.origin, url.pathname + url.search, {})
  }
  return [
    makeRequestTool(
      {
        service: "sabnzbd",
        description:
          "SABnzbd API; every call is GET /api?mode=... and the mode decides what it does. Reads: mode=queue, " +
          "mode=history (limit, start, search, cat, nzo_ids, failed_only), version, warnings, server_stats, get_cats. " +
          "Job writes, each with value={nzo_id}: mode=retry, mode=queue&name=pause|resume, " +
          "mode=queue&name=priority&value2={priority}, mode=change_cat&value2={category}. " +
          "Deleting jobs goes through sabnzbd_delete_job; server-wide and config modes are refused. " +
          "Blitzcrank adds credentials and JSON output.",
        methods: ["GET"],
        route: (_method, path) => sabRoute(path),
        request: (_method, path) =>
          sabCall(Object.fromEntries(new URL(path, cfg.url).searchParams)),
      },
      ctx,
    ),
    deleteJobTool(ctx, sabCall),
  ]
}

function deleteJobTool(ctx: RunContext, sabCall: SabCall): ToolRegistration {
  return defineTool({
    name: "sabnzbd_delete_job",
    description:
      "Remove one job from the SABnzbd queue or history. deleteFiles=true also deletes downloaded data and is recorded as a deletion. Prefer Arr-level queue removal when the Arr still tracks the item; never orphan an Arr that is waiting on this job. The nzo_id must pass the SABnzbd evidence gate.",
    parameters: Type.Object({
      reason: reasonParam(),
      nzoId: Type.String({ minLength: 1 }),
      from: StringEnum(["queue", "history"] as const),
      deleteFiles: Type.Boolean({
        description:
          "Also delete downloaded data from disk (counts as a deletion)",
      }),
    }),
    execute(params) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const outcome = yield* runMutation(ctx, {
            kind: params.deleteFiles ? "delete" : "mutate",
            evidence: [
              { service: "sabnzbd", value: params.nzoId, hint: "nzo_id" },
            ],
            perform: () =>
              sabCall({
                mode: params.from,
                name: "delete",
                value: params.nzoId,
                del_files: params.deleteFiles ? "1" : "0",
              }),
            verify: () =>
              Effect.gen(function* () {
                const list = yield* sabCall({ mode: params.from, limit: "50" })
                ctx.recordRead(
                  "sabnzbd",
                  `/api?mode=${params.from}&limit=50`,
                  JSON.stringify(list),
                )
                return list
              }),
          })
          return textResult(outcome, {
            service: "sabnzbd",
            action: "delete_job",
            from: params.from,
            nzoId: params.nzoId,
          })
        }),
      )
    },
  })
}
