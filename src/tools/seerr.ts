import { StringEnum } from "@earendil-works/pi-ai"
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
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
import { assertSeerrLifecycleOwned } from "./safety.ts"

export function buildSeerrTools(
  cfg: ServiceConfig,
  ctx: RunContext,
): ToolDefinition[] {
  const request = (path: string) =>
    jsonRequestEffect(cfg.url, path, { headers: { "X-Api-Key": cfg.apiKey } })

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
  request: (path: string) => Effect.Effect<JsonValue, JsonRequestError>,
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
    execute(_toolCallId, params) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const body = {
            mediaType: params.mediaType,
            mediaId: params.mediaId,
          }
          if (params.seasons) Object.assign(body, { seasons: params.seasons })
          const outcome = yield* runMutation(ctx, {
            kind: "mutate",
            evidence: [
              { service: "seerr", value: params.mediaId, hint: "tmdbId" },
            ],
            perform: () =>
              jsonRequestEffect(cfg.url, "/api/v1/request", {
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
        }),
      )
    },
  })
}

function verifyCreatedRequest(
  ctx: RunContext,
  request: (path: string) => Effect.Effect<JsonValue, JsonRequestError>,
  result: JsonValue,
): Effect.Effect<JsonValue, JsonRequestError> {
  return Effect.gen(function* () {
    const id =
      isJsonObject(result) && isNumber(result.id) ? result.id : undefined
    if (!id) return { warning: "request response had no id" }
    const path = `/api/v1/request/${id}`
    const created = yield* request(path)
    ctx.recordRead("seerr", path, JSON.stringify(created))
    return created
  })
}

function isJsonObject(
  value: JsonValue,
): value is { [key: string]: JsonValue | undefined } {
  return value !== null && Object(value) === value && !Array.isArray(value)
}

function isNumber<Value>(value: Value): value is Value & number {
  return typeof value === "number"
}
