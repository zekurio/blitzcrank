import type { JsonValue } from "../../http.ts"
import {
  isJsonObject,
  isNumber,
  isString,
  pick,
  pickOrNull,
  type JsonObject,
} from "../../json.ts"

export const MAX_FIELD_CHARS = 500
export const MAX_NAME_CHARS = 160

const MAX_PROVIDER_IDS = 30

/**
 * A bounded scalar: a string cut to `max` characters that says how much was
 * cut, a number or boolean as it is, and `null` for anything else. A named
 * field that arrives as a nested record is therefore never passed on whole.
 */
export function clip(value: JsonValue | undefined, max: number): JsonValue {
  if (isNumber(value) || typeof value === "boolean") return value
  if (!isString(value)) return null
  if (value.length <= max) return value
  return `${value.slice(0, max)}... [${value.length - max} more chars]`
}

/** Bounds every field of a projection that is already a reviewed field set. */
export function clipStrings(
  record: JsonObject,
  max = MAX_FIELD_CHARS,
): JsonObject {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, clip(value, max)]),
  )
}

/**
 * A `ProviderIds` value as a bounded map of strings: `undefined` when Jellyfin
 * sent none, `"malformed"` when it sent something else in its place.
 */
export function parseProviderIds(
  ids: JsonValue | undefined,
): Record<string, string> | "malformed" | undefined {
  if (ids === undefined || ids === null) return undefined
  if (!isJsonObject(ids)) return "malformed"
  const entries = Object.entries(ids)
  if (entries.length > MAX_PROVIDER_IDS) return "malformed"
  const result: Record<string, string> = {}
  for (const [provider, id] of entries) {
    // A provider without an id is the same as a provider that is not listed.
    if (id === undefined || id === null) continue
    if (!isString(id) || id.length > MAX_FIELD_CHARS || provider.length > 60) {
      return "malformed"
    }
    result[provider] = id
  }
  return result
}

/** Identity is matched on provider ids, so malformed ones throw here. */
export function providerIdsOf(
  record: JsonObject,
  what: string,
): Record<string, string> | undefined {
  const ids = parseProviderIds(record.ProviderIds)
  if (ids === "malformed") {
    throw new Error(`jellyfin returned malformed provider ids for ${what}`)
  }
  return ids
}

/** Fields a stream always reports, so `null` is a value Jellyfin has none for. */
export function compactStream(stream: JsonObject): JsonObject {
  return clipStrings(
    {
      ...pickOrNull(stream, [
        "Type",
        "Index",
        "Codec",
        "Language",
        "Title",
        "DisplayTitle",
        "IsDefault",
        "IsForced",
        "IsExternal",
      ]),
      ...pick(stream, [
        "Profile",
        "BitDepth",
        "Channels",
        "ChannelLayout",
        "Height",
        "Width",
        "VideoRange",
        "VideoRangeType",
      ]),
    },
    MAX_NAME_CHARS,
  )
}

/**
 * Identity of one item in a list. An absent key is a field Jellyfin left out.
 * Provider ids that cannot be read are `null`, which is unknown, not none.
 */
export function compactItem(item: JsonObject): JsonObject {
  const ids = parseProviderIds(item.ProviderIds)
  return {
    ...clipStrings(
      pick(item, [
        "Id",
        "Name",
        "Type",
        "LocationType",
        "Path",
        "ParentId",
        "SeriesId",
        "SeriesName",
        "SeasonId",
        "IndexNumber",
        "ParentIndexNumber",
        "ProductionYear",
        "RunTimeTicks",
      ]),
    ),
    ...(ids === undefined
      ? {}
      : { ProviderIds: ids === "malformed" ? null : ids }),
  }
}

export function itemLabel(item: JsonObject): string {
  return `${String(item.Type ?? "item")} ${String(item.Name ?? "unnamed")} (${String(item.Id)})`
}
