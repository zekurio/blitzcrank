import type { ServiceConfig } from "../config.ts"
import { jsonRequestEffect } from "../services/http.ts"
import { makeRequestTool, type HostTool } from "./common.ts"
import type { RunContext } from "./context.ts"
import { jellyfinRoute } from "./safety.ts"

export function buildJellyfinTools(
  cfg: ServiceConfig,
  ctx: RunContext,
): HostTool[] {
  return [
    makeRequestTool(
      {
        service: "jellyfin",
        description:
          "Jellyfin API. GET reads /Items searches, item details with MediaSources (codecs, audio/subtitle " +
          "streams), users, sessions, and /System/Info. Writes: POST /Items/{id}/Refresh, " +
          "POST /Items/RemoteSearch/{type} (lookup only), and POST /Items/RemoteSearch/Apply/{id} to fix a " +
          "wrong match. Deleting items and server settings are refused.",
        methods: ["GET", "POST", "PUT", "DELETE"],
        route: jellyfinRoute,
        request: (method, path, body) =>
          jsonRequestEffect(cfg.url, path, {
            method,
            headers: { "X-Emby-Token": cfg.apiKey },
            ...(body !== undefined ? { body } : {}),
          }),
      },
      ctx,
    ),
  ]
}
