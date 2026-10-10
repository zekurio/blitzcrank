import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable"
import { Effect } from "effect"
import { Type } from "typebox"

import type { ServiceConfig } from "../config.ts"
import {
  jsonRequestEffect,
  type JsonRequestError,
  type JsonValue,
} from "../services/http.ts"
import { makeReadTool, reasonParam, runMutation, textResult } from "./common.ts"
import type { RunContext } from "./context.ts"

export function buildJellyfinTools(
  cfg: ServiceConfig,
  ctx: RunContext,
): ToolRegistration[] {
  // Jellyfin 12 rejects the legacy X-Emby-Token header with HTTP 401 and
  // accepts the key only through the MediaBrowser Authorization scheme.
  const request = (path: string, method: "GET" | "POST" = "GET") =>
    jsonRequestEffect(cfg.url, path, {
      method,
      headers: { Authorization: `MediaBrowser Token="${cfg.apiKey}"` },
    })

  return [
    makeReadTool(
      {
        service: "jellyfin",
        label: "Jellyfin read",
        description:
          "Read Jellyfin state: /Items?... searches, item details with MediaSources (codecs, audio/subtitle streams), /System/Info, /Sessions.",
        request: (path) => request(path),
      },
      ctx,
    ),
    refreshItemTool(ctx, request),
  ]
}

function refreshItemTool(
  ctx: RunContext,
  request: (
    path: string,
    method?: "GET" | "POST",
  ) => Effect.Effect<JsonValue, JsonRequestError>,
): ToolRegistration {
  return defineTool({
    name: "jellyfin_refresh_item",
    description:
      "Trigger a metadata refresh for one Jellyfin item. The item id must come from a Jellyfin read this run.",
    parameters: Type.Object({
      reason: reasonParam(),
      itemId: Type.String({ minLength: 1 }),
    }),
    execute(params) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const outcome = yield* runMutation(ctx, {
            kind: "mutate",
            evidence: [
              { service: "jellyfin", value: params.itemId, hint: "item id" },
            ],
            perform: () =>
              request(
                `/Items/${encodeURIComponent(params.itemId)}/Refresh`,
                "POST",
              ),
          })
          return textResult(outcome, {
            service: "jellyfin",
            action: "refresh_item",
            itemId: params.itemId,
          })
        }),
      )
    },
  })
}
