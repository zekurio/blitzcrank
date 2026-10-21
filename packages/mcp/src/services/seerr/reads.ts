import { Effect } from "effect"
import { Type } from "typebox"

import type { ServiceConfig } from "../../config.ts"
import {
  isJsonObject,
  isNumber,
  isString,
  objectField,
  objectList,
  pick,
} from "../../json.ts"
import { rawPath, rawResult } from "../../tools/raw.ts"
import { resource } from "../../tools/reads.ts"
import { listResult } from "../../tools/results.ts"
import { seerrObject, seerrRequest } from "./client.ts"
import {
  compactMedia,
  compactPerson,
  compactRequest,
  labelled,
  permissionNames,
  year,
} from "./compact.ts"

const MAX_OVERVIEW_CHARS = 300

/** Codes from jellyseerr `server/constants`. */
const ISSUE_TYPES = ["", "video", "audio", "subtitles", "other"]
const ISSUE_STATUS = ["", "open", "resolved"]

/** Seerr rejects a query holding any RFC 3986 reserved character. */
function encodeQuery(query: string): string {
  return encodeURIComponent(query).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

export function seerrReads(cfg: ServiceConfig) {
  return {
    issue: resource({
      description:
        "One issue with its comments, media identity, and reporter, including the reporter's jellyfinUserId",
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
      description:
        "One user with their linked jellyfinUserId, a permissions summary, and request limits",
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
              "jellyfinUserId",
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
        "Any other GET below /api/v1. Uncompacted; prefer a named tool",
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
