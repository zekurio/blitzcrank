import type { Effect } from "effect"

import type { ServiceConfig } from "../../config.ts"
import {
  jsonRequestEffect,
  type JsonRequestOptions,
  type JsonValue,
  type Signal,
} from "../../http.ts"
import type { JsonObject } from "../../json.ts"
import { requireRecord, type ToolFailure } from "../../tools/errors.ts"

export function seerrRequest(
  cfg: ServiceConfig,
  path: string,
  opts: JsonRequestOptions = {},
) {
  return jsonRequestEffect<JsonValue | undefined>(cfg.url, path, {
    ...opts,
    headers: { "X-Api-Key": cfg.apiKey },
  })
}

export function seerrObject(
  cfg: ServiceConfig,
  path: string,
  what: string,
  signal: Signal,
): Effect.Effect<JsonObject, ToolFailure> {
  return requireRecord("seerr", what, seerrRequest(cfg, path, { signal }))
}
