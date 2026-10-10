import type { ServiceConfig } from "../config.ts"
import { jsonRequestEffect } from "../services/http.ts"
import { makeRequestTool, type HostTool } from "./common.ts"
import type { RunContext } from "./context.ts"
import { seerrRoute } from "./safety.ts"

export function buildSeerrTools(
  cfg: ServiceConfig,
  ctx: RunContext,
): HostTool[] {
  return [
    makeRequestTool(
      {
        service: "seerr",
        description:
          "Jellyseerr API under /api/v1. GET reads issues, requests, media, search, users, and quotas. " +
          "Writes: POST /api/v1/request (body mediaType, mediaId as TMDB id, seasons for TV) and " +
          "POST /api/v1/request/{id}/retry. Comments and issue status are host-owned; settings and " +
          "request moderation are refused.",
        methods: ["GET", "POST", "PUT", "DELETE"],
        route: seerrRoute,
        request: (method, path, body) =>
          jsonRequestEffect(cfg.url, path, {
            method,
            headers: { "X-Api-Key": cfg.apiKey },
            ...(body !== undefined ? { body } : {}),
          }),
      },
      ctx,
    ),
  ]
}
