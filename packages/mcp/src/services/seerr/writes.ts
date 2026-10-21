import { Effect } from "effect"
import { Type } from "typebox"

import type { ServiceConfig } from "../../config.ts"
import type { JsonValue } from "../../http.ts"
import {
  isJsonObject,
  isNumber,
  objectField,
  objectList,
  type JsonObject,
} from "../../json.ts"
import { toolFail } from "../../tools/errors.ts"
import { action, type WriteEffect } from "../../tools/writes.ts"
import { seerrObject, seerrRequest } from "./client.ts"
import { compactRequest, REQUEST_STATUS, year } from "./compact.ts"

const REQUEST_FAILED = 4
const MEDIA_AVAILABLE = 5

/** The request set a new request would join. */
function existingRequests(details: JsonObject): JsonObject[] {
  return objectList(objectField(details, "mediaInfo")?.requests)
}

function seasonNumbers(value: JsonValue | undefined): number[] {
  return objectList(value)
    .flatMap((season) =>
      isNumber(season.seasonNumber) ? [season.seasonNumber] : [],
    )
    .sort((a, b) => a - b)
}

function requestSummary(request: JsonObject): string {
  const seasons = seasonNumbers(request.seasons)
  const by = objectField(request, "requestedBy")
  return [
    `request ${String(request.id)}`,
    isNumber(request.status)
      ? (REQUEST_STATUS[request.status] ?? "unknown status")
      : "unknown status",
    ...(seasons.length > 0 ? [`seasons ${seasons.join(", ")}`] : []),
    ...(by ? [`by ${String(by.displayName ?? by.id)}`] : []),
  ].join(", ")
}

export function seerrActions(cfg: ServiceConfig) {
  return {
    create_request: action({
      description:
        "Request a movie or series, which is how media gets added to the Arrs",
      params: Type.Object({
        mediaType: Type.Enum(["movie", "tv"]),
        mediaId: Type.Integer({
          minimum: 1,
          description: "TMDB id, for TV too",
        }),
        seasons: Type.Optional(
          Type.Array(Type.Integer({ minimum: 0 }), {
            minItems: 1,
            description: "TV only. Omit to request every season",
          }),
        ),
        userId: Type.Optional(
          Type.Integer({
            minimum: 1,
            description: "Seerr user the request belongs to",
          }),
        ),
      }),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          if (params.mediaType === "movie" && params.seasons !== undefined) {
            return yield* toolFail("seasons applies to tv requests only")
          }
          const details = yield* seerrObject(
            cfg,
            `/api/v1/${params.mediaType}/${params.mediaId}`,
            `${params.mediaType} with TMDB id ${params.mediaId}`,
            signal,
          )
          const known = seasonNumbers(details.seasons)
          const unknown = (params.seasons ?? []).filter(
            (season) => !known.includes(season),
          )
          if (unknown.length > 0) {
            return yield* toolFail(
              `that series has no season ${unknown.join(", ")}; it has ${known.join(", ")}`,
            )
          }
          const user =
            params.userId === undefined
              ? undefined
              : yield* seerrObject(
                  cfg,
                  `/api/v1/user/${params.userId}`,
                  `user ${params.userId}`,
                  signal,
                )
          const title = `${String(details.title ?? details.name ?? "untitled")} (${String(year(details.releaseDate ?? details.firstAirDate) ?? "unknown year")})`
          const requests = existingRequests(details)
          const mediaStatus = objectField(details, "mediaInfo")?.status
          const seasonText =
            params.mediaType === "movie"
              ? []
              : [
                  params.seasons
                    ? `seasons ${params.seasons.join(", ")}`
                    : "every season",
                ]
          const effect: WriteEffect = {
            kind: "request",
            target: `${params.mediaType} ${title}, TMDB ${params.mediaId}`,
            detail: [
              ...seasonText,
              user
                ? `requested as ${String(user.displayName ?? user.id)}`
                : "requested as the API user",
            ].join("; "),
          }
          return {
            state: null,
            summary: `Request ${params.mediaType} ${title}${seasonText.length > 0 ? `, ${seasonText.join("")}` : ""}`,
            effects: [effect],
            warnings: [
              ...requests.map(
                (request) => `already requested: ${requestSummary(request)}`,
              ),
              ...(mediaStatus === MEDIA_AVAILABLE
                ? ["Seerr already marks this media available"]
                : []),
            ],
          }
        }),
      write: (params) =>
        seerrRequest(cfg, "/api/v1/request", {
          method: "POST",
          body: {
            mediaType: params.mediaType,
            mediaId: params.mediaId,
            ...(params.mediaType === "tv"
              ? { seasons: params.seasons ?? "all" }
              : {}),
            ...(params.userId !== undefined ? { userId: params.userId } : {}),
          },
        }).pipe(
          Effect.map((request) =>
            isJsonObject(request) ? compactRequest(request) : request,
          ),
        ),
      verify: (_params, result) => {
        const id = isJsonObject(result) ? result.id : undefined
        if (!isNumber(id)) {
          return Effect.succeed({
            warning:
              "the response named no request id; search the media to see its requests",
          })
        }
        return seerrObject(
          cfg,
          `/api/v1/request/${id}`,
          `request ${id}`,
          undefined,
        ).pipe(Effect.map(compactRequest))
      },
    }),
    retry_request: action({
      description:
        "Re-send a failed request to its Arr, once the cause is fixed",
      params: Type.Object({ requestId: Type.Integer({ minimum: 1 }) }),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const request = yield* seerrObject(
            cfg,
            `/api/v1/request/${params.requestId}`,
            `request ${params.requestId}`,
            signal,
          )
          const media = objectField(request, "media")
          const type = String(request.type ?? media?.mediaType ?? "media")
          // The title is only for the reader; a retry does not depend on it.
          const details = isNumber(media?.tmdbId)
            ? yield* seerrObject(
                cfg,
                `/api/v1/${type}/${media.tmdbId}`,
                "title",
                signal,
              ).pipe(Effect.orElseSucceed(() => undefined))
            : undefined
          const title = String(
            details?.title ??
              details?.name ??
              `TMDB ${String(media?.tmdbId ?? "unknown")}`,
          )
          const effect: WriteEffect = {
            kind: "retry",
            target: `request ${params.requestId}: ${type} ${title}`,
            detail: requestSummary(request),
          }
          return {
            state: null,
            summary: `Retry request ${params.requestId} for ${type} ${title}`,
            effects: [effect],
            warnings:
              request.status === REQUEST_FAILED
                ? []
                : [
                    `the request is ${isNumber(request.status) ? (REQUEST_STATUS[request.status] ?? "in an unknown state") : "in an unknown state"}, not failed`,
                  ],
          }
        }),
      write: (params) =>
        seerrRequest(cfg, `/api/v1/request/${params.requestId}/retry`, {
          method: "POST",
        }).pipe(
          Effect.map((request) =>
            isJsonObject(request) ? compactRequest(request) : request,
          ),
        ),
      verify: (params) =>
        seerrObject(
          cfg,
          `/api/v1/request/${params.requestId}`,
          `request ${params.requestId}`,
          undefined,
        ).pipe(Effect.map(compactRequest)),
    }),
  }
}
