import { Effect } from "effect"
import { Type } from "typebox"

import type { ServiceConfig } from "../config.ts"
import {
  jsonRequestEffect,
  type JsonRequestOptions,
  type JsonValue,
} from "../http.ts"
import {
  isJsonObject,
  isNumber,
  isString,
  objectField,
  objectList,
  pick,
  type JsonObject,
} from "../json.ts"
import type { PlanStore } from "../plans.ts"
import {
  action,
  defineRead,
  definePlanApply,
  listResult,
  rawPath,
  rawResult,
  resource,
  toolFail,
  type PlanEffect,
  type ServerTool,
  type ToolFailure,
} from "../tools.ts"

type Signal = AbortSignal | undefined

const MAX_OVERVIEW_CHARS = 300

/** Codes from jellyseerr `server/constants`. */
const ISSUE_TYPES = ["", "video", "audio", "subtitles", "other"]
const ISSUE_STATUS = ["", "open", "resolved"]
const REQUEST_STATUS = [
  "",
  "pending approval",
  "approved",
  "declined",
  "failed",
  "completed",
]
const MEDIA_STATUS = [
  "",
  "unknown",
  "pending",
  "processing",
  "partially available",
  "available",
  "blocklisted",
  "deleted",
]
const REQUEST_FAILED = 4
const MEDIA_AVAILABLE = 5

/** Bits from jellyseerr `server/lib/permissions.ts`. */
const PERMISSIONS: Record<string, number> = {
  ADMIN: 2,
  MANAGE_SETTINGS: 4,
  MANAGE_USERS: 8,
  MANAGE_REQUESTS: 16,
  REQUEST: 32,
  AUTO_APPROVE: 128,
  AUTO_APPROVE_MOVIE: 256,
  AUTO_APPROVE_TV: 512,
  REQUEST_4K: 1024,
  REQUEST_ADVANCED: 8192,
  REQUEST_VIEW: 16_384,
  REQUEST_MOVIE: 262_144,
  REQUEST_TV: 524_288,
  MANAGE_ISSUES: 1_048_576,
  VIEW_ISSUES: 2_097_152,
  CREATE_ISSUES: 4_194_304,
}

export function buildSeerrTools(
  cfg: ServiceConfig,
  plans: PlanStore,
): ServerTool[] {
  return [
    defineRead(
      "seerr",
      "Read Seerr issues, requests, media identity, users, and quotas.",
      seerrReads(cfg),
    ),
    ...definePlanApply("seerr", seerrActions(cfg), plans),
  ]
}

function seerrRequest(
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
function seerrObject(
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

function labelled(code: JsonValue | undefined, labels: string[]): JsonObject {
  if (!isNumber(code)) return {}
  return { status: code, statusLabel: labels[code] ?? "unknown" }
}

/** Who someone is, without the email address Seerr stores next to it. */
function compactPerson(user: JsonObject | undefined): JsonValue {
  if (!user) return null
  return pick(user, ["id", "displayName", "username", "jellyfinUsername"])
}

function compactMedia(media: JsonObject | undefined): JsonValue {
  if (!media) return null
  return {
    ...pick(media, [
      "id",
      "mediaType",
      "tmdbId",
      "tvdbId",
      "imdbId",
      "jellyfinMediaId",
      "externalServiceId",
      "externalServiceSlug",
    ]),
    ...labelled(media.status, MEDIA_STATUS),
  }
}

function compactRequest(request: JsonObject): JsonObject {
  return {
    ...pick(request, ["id", "type", "is4k", "createdAt", "updatedAt"]),
    ...labelled(request.status, REQUEST_STATUS),
    seasons: objectList(request.seasons).map((season) =>
      pick(season, ["seasonNumber", "status"]),
    ),
    requestedBy: compactPerson(objectField(request, "requestedBy")),
    media: compactMedia(objectField(request, "media")),
  }
}

function permissionNames(bits: number): string[] {
  return Object.entries(PERMISSIONS).flatMap(([name, bit]) =>
    (bits & bit) !== 0 ? [name] : [],
  )
}

/** Seerr rejects a query holding any RFC 3986 reserved character. */
function encodeQuery(query: string): string {
  return encodeURIComponent(query).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function year(date: JsonValue | undefined): JsonValue {
  return isString(date) && date.length >= 4 ? Number(date.slice(0, 4)) : null
}

function seerrReads(cfg: ServiceConfig) {
  return {
    issue: resource({
      description: "One issue with its comments, media identity, and reporter",
      params: Type.Object({ issueId: Type.Integer({ minimum: 1 }) }),
      run: (params, signal) =>
        seerrObject(
          cfg,
          `/api/v1/issue/${params.issueId}`,
          `issue ${params.issueId}`,
          signal,
        ).pipe(
          Effect.map((issue) => ({
            ...pick(issue, [
              "id",
              "problemSeason",
              "problemEpisode",
              "createdAt",
              "updatedAt",
            ]),
            issueType: isNumber(issue.issueType)
              ? (ISSUE_TYPES[issue.issueType] ?? "unknown")
              : null,
            ...labelled(issue.status, ISSUE_STATUS),
            createdBy: compactPerson(objectField(issue, "createdBy")),
            media: compactMedia(objectField(issue, "media")),
            comments: objectList(issue.comments).map((comment) => ({
              ...pick(comment, ["id", "message", "createdAt"]),
              user: compactPerson(objectField(comment, "user")),
            })),
          })),
        ),
    }),
    request: resource({
      description: "One request with its status, seasons, and requester",
      params: Type.Object({ requestId: Type.Integer({ minimum: 1 }) }),
      run: (params, signal) =>
        seerrObject(
          cfg,
          `/api/v1/request/${params.requestId}`,
          `request ${params.requestId}`,
          signal,
        ).pipe(Effect.map(compactRequest)),
    }),
    search: resource({
      description:
        "Find movies and series by title, with their TMDB ids and request state",
      params: Type.Object({ query: Type.String({ minLength: 1 }) }),
      run: (params, signal) =>
        seerrRequest(
          cfg,
          `/api/v1/search?query=${encodeQuery(params.query)}&page=1`,
          { signal },
        ).pipe(
          Effect.map((response) => {
            const page = isJsonObject(response) ? response : undefined
            const matches = objectList(page?.results).filter(
              (result) =>
                result.mediaType === "movie" || result.mediaType === "tv",
            )
            return listResult(
              matches.map((result) => {
                const media = objectField(result, "mediaInfo")
                return {
                  mediaType: result.mediaType ?? null,
                  tmdbId: result.id ?? null,
                  ...(media?.tvdbId !== undefined
                    ? { tvdbId: media.tvdbId }
                    : {}),
                  title: result.title ?? result.name ?? null,
                  year: year(result.releaseDate ?? result.firstAirDate),
                  overview: isString(result.overview)
                    ? result.overview.slice(0, MAX_OVERVIEW_CHARS)
                    : null,
                  ...(media ? { mediaInfo: compactMedia(media) } : {}),
                }
              }),
              {
                total: isNumber(page?.totalResults)
                  ? page.totalResults
                  : matches.length,
              },
            )
          }),
        ),
    }),
    user: resource({
      description: "One user with a permissions summary and request limits",
      params: Type.Object({ userId: Type.Integer({ minimum: 1 }) }),
      run: (params, signal) =>
        seerrObject(
          cfg,
          `/api/v1/user/${params.userId}`,
          `user ${params.userId}`,
          signal,
        ).pipe(
          Effect.map((user) => ({
            ...pick(user, [
              "id",
              "displayName",
              "username",
              "jellyfinUsername",
              "requestCount",
              "movieQuotaLimit",
              "movieQuotaDays",
              "tvQuotaLimit",
              "tvQuotaDays",
            ]),
            permissions: isNumber(user.permissions)
              ? permissionNames(user.permissions)
              : [],
          })),
        ),
    }),
    quota: resource({
      description: "One user's remaining movie and TV request quota",
      params: Type.Object({ userId: Type.Integer({ minimum: 1 }) }),
      run: (params, signal) =>
        seerrObject(
          cfg,
          `/api/v1/user/${params.userId}/quota`,
          `user ${params.userId}`,
          signal,
        ).pipe(Effect.map((quota) => pick(quota, ["movie", "tv"]))),
    }),
    raw: resource({
      description:
        "Any other GET below /api/v1. Uncompacted; prefer a named resource",
      params: Type.Object({
        path: Type.String({
          description:
            "Service-relative path with its query string, e.g. /api/v1/media?take=20",
        }),
      }),
      run: (params, signal) =>
        Effect.gen(function* () {
          const path = yield* rawPath(params.path, "/api/v1")
          const response = yield* seerrRequest(cfg, path, {
            signal,
            jsonOnly: true,
          })
          return rawResult(response, [cfg.apiKey])
        }),
    }),
  }
}

/** The request set a new request would join, as a plan depends on it. */
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

function seerrActions(cfg: ServiceConfig) {
  return {
    createRequest: action({
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
      plan: (params, signal) =>
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
          const effect: PlanEffect = {
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
            state: { requests, mediaStatus: mediaStatus ?? null },
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
      fingerprint: (state) => ({
        mediaStatus: state.mediaStatus,
        requests: state.requests
          .map((request) => ({
            id: isNumber(request.id) ? request.id : 0,
            status: request.status ?? null,
            seasons: seasonNumbers(request.seasons),
          }))
          .sort((a, b) => a.id - b.id),
      }),
      apply: (params) =>
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
    retryRequest: action({
      description:
        "Re-send a failed request to its Arr, once the cause is fixed",
      params: Type.Object({ requestId: Type.Integer({ minimum: 1 }) }),
      plan: (params, signal) =>
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
          const effect: PlanEffect = {
            kind: "retry",
            target: `request ${params.requestId}: ${type} ${title}`,
            detail: requestSummary(request),
          }
          return {
            state: { request },
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
      fingerprint: (state) => ({
        requestId: state.request.id ?? null,
        status: state.request.status ?? null,
        seasons: seasonNumbers(state.request.seasons),
      }),
      apply: (params) =>
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
