import { Effect } from "effect"

import type { ServiceConfig } from "../../config.ts"
import { jsonRequestEffect, type JsonValue, type Signal } from "../../http.ts"
import { isJsonObject, stringList, type JsonObject } from "../../json.ts"
import { toolFail, type ToolFailure } from "../../tools/errors.ts"

export type SabParams = Record<string, string | number | undefined>

/**
 * Every SABnzbd call is `GET /api?mode=...`; the mode decides whether it
 * reads or writes. The key travels in the query string, so the HTTP helper
 * redacts it from any error. An API-level failure answers HTTP 200 with
 * `status: false`.
 */
export function sabCall(
  cfg: ServiceConfig,
  params: SabParams,
  signal: Signal,
): Effect.Effect<JsonObject, ToolFailure> {
  return jsonRequestEffect<JsonValue | undefined>(cfg.url, "/api", {
    query: { ...params, apikey: cfg.apiKey, output: "json" },
    signal,
  }).pipe(
    Effect.flatMap((response) => {
      if (!isJsonObject(response)) {
        return toolFail(
          `sabnzbd returned no JSON object for mode ${params.mode}`,
        )
      }
      if (response.status === false) {
        return toolFail(
          `sabnzbd refused mode ${params.mode}: ${String(response.error ?? "no reason given")}`,
        )
      }
      return Effect.succeed(response)
    }),
  )
}

export function readCategories(cfg: ServiceConfig, signal: Signal) {
  return sabCall(cfg, { mode: "get_cats" }, signal).pipe(
    Effect.map((response) => stringList(response.categories)),
  )
}
