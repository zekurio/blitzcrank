import { Effect } from "effect"

import type { ServiceConfig } from "../../config.ts"
import {
  jsonRequestEffect,
  type JsonRequestOptions,
  type JsonValue,
  type Signal,
} from "../../http.ts"
import { isJsonObject, type JsonObject } from "../../json.ts"
import { toolFail, type ToolFailure } from "../../tools/errors.ts"

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

/** One record by path. A 404 is Seerr saying the id does not exist. */
export function seerrObject(
  cfg: ServiceConfig,
  path: string,
  what: string,
  signal: Signal,
): Effect.Effect<JsonObject, ToolFailure> {
  return seerrRequest(cfg, path, { signal }).pipe(
    Effect.catchTag(
      "HttpError",
      (error): Effect.Effect<never, ToolFailure> =>
        error.status === 404
          ? toolFail(`seerr has no ${what}`)
          : Effect.fail(error),
    ),
    Effect.flatMap((value) =>
      isJsonObject(value)
        ? Effect.succeed(value)
        : toolFail(`seerr returned no record for ${what}`),
    ),
  )
}
