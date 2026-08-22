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
import { assertSeerrLifecycleOwned } from "./safety.ts"

export function buildSeerrTools(
  cfg: ServiceConfig,
  ctx: RunContext,
): ToolDefinition[] {
  const request = (path: string) =>
    jsonRequest(cfg.url, path, { headers: { "X-Api-Key": cfg.apiKey } })

  return [
    makeReadTool(
      {
        service: "seerr",
        label: "Seerr read",
        description:
          "Read Jellyseerr state via /api/v1 paths: issue details (/api/v1/issue/{id}), requests, media. Comments and issue status are host-owned.",
        guards: assertSeerrLifecycleOwned,
        request,
      },
      ctx,
    ),
    createRequestTool(cfg, ctx, request),
  ]
}

function createRequestTool(
  cfg: ServiceConfig,
  ctx: RunContext,
  request: (path: string) => Promise<JsonValue>,
): ToolDefinition {
  return defineTool({
    name: "seerr_create_request",
    label: "Seerr: create media request",
    description:
      "Create a new Jellyseerr media request (e.g. re-request media that was reported missing and is absent from the Arr). The tmdbId must come from a read this run.",
    parameters: Type.Object({
      reason: reasonParam(),
      mediaType: StringEnum(["movie", "tv"] as const),
      mediaId: Type.Integer({
        minimum: 1,
        description: "TMDB id of the media",
      }),
      seasons: Type.Optional(
        Type.Array(Type.Integer({ minimum: 0 }), {
          description: "Season numbers for tv requests",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const body = {
        mediaType: params.mediaType,
        mediaId: params.mediaId,
      }
      if (params.seasons) Object.assign(body, { seasons: params.seasons })
      const outcome = await runMutation(ctx, {
        kind: "mutate",
        evidence: [{ service: "seerr", value: params.mediaId, hint: "tmdbId" }],
        perform: () =>
          jsonRequest(cfg.url, "/api/v1/request", {
            method: "POST",
            headers: { "X-Api-Key": cfg.apiKey },
            body,
          }),
        verify: (result) => verifyCreatedRequest(ctx, request, result),
      })
      return textResult(outcome, {
        service: "seerr",
        action: "create_request",
        mediaId: params.mediaId,
      })
    },
  })
}

async function verifyCreatedRequest(
  ctx: RunContext,
  request: (path: string) => Promise<JsonValue>,
  result: JsonValue,
): Promise<JsonValue> {
  const id = isJsonObject(result) && isNumber(result.id) ? result.id : undefined
  if (!id) return { warning: "request response had no id" }
  const path = `/api/v1/request/${id}`
  const created = await request(path)
  ctx.recordRead("seerr", path, JSON.stringify(created))
  return created
}

function isJsonObject(
  value: JsonValue,
): value is { [key: string]: JsonValue | undefined } {
  return value !== null && Object(value) === value && !Array.isArray(value)
}

function isNumber<Value>(value: Value): value is Value & number {
  return typeof value === "number"
}
