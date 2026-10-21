import type { JsonValue } from "../../http.ts"
import {
  isJsonObject,
  isNumber,
  isString,
  names,
  objectField,
  objectList,
  pick,
  stringList,
  type JsonObject,
} from "../../json.ts"

const MAX_NAMES = 30
const MAX_SETTING_CHARS = 300

export function compactQueueItem(item: JsonObject): JsonObject {
  const messages = objectList(item.statusMessages).map((message) => ({
    title: message.title ?? null,
    messages: stringList(message.messages),
  }))
  return {
    ...pick(item, [
      "id",
      "title",
      "status",
      "trackedDownloadStatus",
      "trackedDownloadState",
      "errorMessage",
      "downloadId",
      "protocol",
      "downloadClient",
      "indexer",
      "outputPath",
      "size",
      "sizeleft",
      "estimatedCompletionTime",
      "seriesId",
      "episodeId",
      "seasonNumber",
      "movieId",
    ]),
    quality: qualityName(item.quality),
    ...(messages.length > 0 ? { statusMessages: messages } : {}),
  }
}

/**
 * A grab and the import that followed carry their own parsed quality, score,
 * and formats. Where they differ is where an upgrade loop shows up.
 */
export function compactHistory(record: JsonObject): JsonObject {
  return {
    ...pick(record, [
      "id",
      "eventType",
      "date",
      "sourceTitle",
      "downloadId",
      "seriesId",
      "episodeId",
      "movieId",
    ]),
    quality: qualityName(record.quality),
    languages: namesOrNull(record.languages),
    ...scalars(record, ["customFormatScore", "qualityCutoffNotMet"]),
    customFormats: namesOrNull(record.customFormats),
    data: pick(objectField(record, "data"), [
      "droppedPath",
      "importedPath",
      "reason",
      "message",
      "indexer",
      "releaseGroup",
      "downloadClient",
      "downloadClientName",
    ]),
  }
}

export function compactBlocklistItem(item: JsonObject): JsonObject {
  return pick(item, [
    "id",
    "sourceTitle",
    "date",
    "protocol",
    "indexer",
    "message",
    "seriesId",
    "episodeIds",
    "movieId",
  ])
}

export function compactQualityProfile(
  profile: JsonObject,
  offset: number,
): JsonObject {
  const items = objectList(profile.items)
  const scores = objectList(profile.formatItems).filter(
    (item) => isNumber(item.score) && item.score !== 0,
  )
  const listed = scores.slice(offset, offset + 60)
  const cutoff = items.find(
    (item) =>
      item.id === profile.cutoff ||
      objectField(item, "quality")?.id === profile.cutoff,
  )
  return {
    ...pick(profile, [
      "id",
      "name",
      "upgradeAllowed",
      "minFormatScore",
      "cutoffFormatScore",
      "minUpgradeFormatScore",
    ]),
    cutoff: cutoff?.name ?? objectField(cutoff, "quality")?.name ?? null,
    // Ordered worst to best, as the Arr ranks them.
    allowedQualities: items
      .filter((item) => item.allowed === true)
      .map((item) => item.name ?? objectField(item, "quality")?.name ?? null),
    formatScores: listed.map((item) => ({
      name: item.name ?? null,
      score: item.score ?? null,
    })),
    formatScoresTotal: scores.length,
    formatScoresOffset: offset,
    ...(offset + listed.length < scores.length
      ? { nextFormatScoreOffset: offset + listed.length }
      : {}),
  }
}

/** `quality` is a `{ quality: { name }, revision }` model on every record. */
export function qualityName(value: JsonValue | undefined): JsonValue {
  const model = isJsonObject(value) ? value : undefined
  return objectField(model, "quality")?.name ?? null
}

/**
 * The names in a list. `null` when the Arr sent no list, or one with an entry
 * that carries no name: unknown, not none. Only an empty list is known empty.
 */
export function namesOrNull(value: JsonValue | undefined): string[] | null {
  if (!Array.isArray(value)) return null
  const all = names(value)
  if (all.length !== value.length) return null
  return all.length > MAX_NAMES
    ? [...all.slice(0, MAX_NAMES), `(${all.length - MAX_NAMES} more)`]
    : all
}

/** A bounded scalar, or `null` for anything else in its place. */
export function scalar(
  value: JsonValue | undefined,
  max = MAX_SETTING_CHARS,
): JsonValue {
  if (isString(value)) return value.slice(0, max)
  return isNumber(value) || typeof value === "boolean" ? value : null
}

/**
 * The listed fields as bounded scalars, so no nested record passes through.
 * `null` is a field the Arr did not send, which is not a false.
 */
export function scalars(
  record: JsonObject,
  keys: readonly string[],
): JsonObject {
  return Object.fromEntries(keys.map((key) => [key, scalar(record[key])]))
}

export function sizeText(bytes: JsonValue | undefined): string {
  if (!isNumber(bytes)) return "unknown size"
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
  return `${Math.round(bytes / 1024 ** 2)} MiB`
}
