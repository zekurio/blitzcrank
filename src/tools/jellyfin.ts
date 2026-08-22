import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

import type { ServiceConfig } from "../config.ts"
import { jsonRequest, type JsonValue } from "../services/http.ts"
import { makeReadTool, reasonParam, runMutation, textResult } from "./common.ts"
import type { RunContext } from "./context.ts"

export function buildJellyfinTools(
  cfg: ServiceConfig,
  ctx: RunContext,
): ToolDefinition[] {
  const request = (path: string, method: "GET" | "POST" = "GET") =>
    jsonRequest(cfg.url, path, {
      method,
      headers: { "X-Emby-Token": cfg.apiKey },
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
  request: (path: string, method?: "GET" | "POST") => Promise<JsonValue>,
): ToolDefinition {
  return defineTool({
    name: "jellyfin_refresh_item",
    label: "Jellyfin: refresh item",
    description:
      "Trigger a metadata refresh for one Jellyfin item. The item id must come from a Jellyfin read this run.",
    parameters: Type.Object({
      reason: reasonParam(),
      itemId: Type.String({ minLength: 1 }),
    }),
    async execute(_toolCallId, params) {
      const outcome = await runMutation(ctx, {
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
    },
  })
}
