import type { JsonValue } from "../../http.ts"
import {
  isNumber,
  isString,
  objectField,
  objectList,
  pick,
  type JsonObject,
} from "../../json.ts"

export const REQUEST_STATUS = [
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

export function labelled(
  code: JsonValue | undefined,
  labels: string[],
): JsonObject {
  if (!isNumber(code)) return {}
  return { status: code, statusLabel: labels[code] ?? "unknown" }
}

/**
 * Who someone is, without the email address Seerr stores next to it.
 * `jellyfinUserId` is the Jellyfin account Seerr linked them to, which is
 * what identifies them there; a display name does not.
 */
export function compactPerson(user: JsonObject | undefined): JsonValue {
  if (!user) return null
  return pick(user, [
    "id",
    "displayName",
    "username",
    "jellyfinUsername",
    "jellyfinUserId",
  ])
}

export function compactMedia(media: JsonObject | undefined): JsonValue {
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

export function compactRequest(request: JsonObject): JsonObject {
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

export function permissionNames(bits: number): string[] {
  return Object.entries(PERMISSIONS).flatMap(([name, bit]) =>
    (bits & bit) !== 0 ? [name] : [],
  )
}

export function year(date: JsonValue | undefined): JsonValue {
  return isString(date) && date.length >= 4 ? Number(date.slice(0, 4)) : null
}
