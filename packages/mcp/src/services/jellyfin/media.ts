import { isJsonObject, pick, type JsonObject } from "../../json.ts"
import { largestFitting, MAX_RESULT_CHARS } from "../../tools/results.ts"
import { itemKey } from "./client.ts"
import {
  clip,
  clipStrings,
  compactItem,
  compactStream,
  MAX_FIELD_CHARS,
  MAX_NAME_CHARS,
  providerIdsOf,
} from "./compact.ts"

/** One media source: its own fields, and its streams when it sent a list. */
interface MediaSource {
  fields: JsonObject
  streams: JsonObject[] | undefined
}

/**
 * Media sources with their streams, or `undefined` when Jellyfin sent none,
 * as it does for a folder. A list or stream list in another shape throws: it
 * would otherwise read as a file without tracks.
 */
function mediaSourcesOf(item: JsonObject): MediaSource[] | undefined {
  const sources = item.MediaSources
  if (sources === undefined || sources === null) return undefined
  const malformed = `jellyfin returned malformed media sources for item ${String(item.Id)}`
  if (!Array.isArray(sources)) throw new Error(malformed)
  return sources.map((source) => {
    if (!isJsonObject(source)) throw new Error(malformed)
    const fields = clipStrings(
      pick(source, ["Id", "Path", "Container", "Size", "Bitrate"]),
    )
    const streams = source.MediaStreams
    if (streams === undefined || streams === null) {
      return { fields, streams: undefined }
    }
    if (!Array.isArray(streams) || !streams.every(isJsonObject)) {
      throw new Error(malformed)
    }
    return { fields, streams: streams.map(compactStream) }
  })
}

/** Where a listing of one item's media starts: a source, and a stream of it. */
interface MediaStart {
  source: number
  stream: number
}

export const WHOLE_MEDIA: MediaStart = { source: 0, stream: 0 }

/** One source with `count` of its streams from `from` on. */
function sourceListing(
  source: MediaSource,
  from: number,
  count: number,
): JsonObject {
  if (source.streams === undefined) {
    return { ...source.fields, MediaStreams: null }
  }
  const total = source.streams.length
  return {
    ...source.fields,
    ...(from > 0 || from + count < total ? { MediaStreamsTotal: total } : {}),
    ...(from > 0 ? { MediaStreamsStartIndex: from } : {}),
    MediaStreams: source.streams.slice(from, from + count),
  }
}

/**
 * Identity and media of one item. `null` is a field Jellyfin did not send,
 * which is not a finding that the thing is absent.
 *
 * Sources are listed from `start` on for as long as `fits` accepts the item,
 * the last of them with as many streams as still fit. `mediaNext` is where
 * the rest starts. A source is listed with at least one of its remaining
 * streams or not at all, so a listed source never reads as one without
 * tracks. Throws when not even the first stream fits beside the identity.
 */
export function mediaItem(
  item: JsonObject,
  start: MediaStart,
  fits: (item: JsonObject) => boolean,
): JsonObject {
  const what = `item ${String(item.Id)}`
  const identity: JsonObject = {
    ...compactItem(item),
    LocationType: clip(item.LocationType, MAX_NAME_CHARS),
    Path: clip(item.Path, MAX_FIELD_CHARS),
    ProviderIds: providerIdsOf(item, what) ?? null,
  }
  const sources = mediaSourcesOf(item)
  const paged = start.source > 0 || start.stream > 0
  if (sources === undefined) {
    if (paged) {
      throw new Error(
        `jellyfin sent no media sources for ${what} to read on in`,
      )
    }
    return fitted({ ...identity, MediaSources: null }, what, fits)
  }
  const first = sources[start.source]
  if (paged && first === undefined) {
    throw new Error(
      `${what} has ${sources.length} media sources, so mediaSourceIndex must be below that`,
    )
  }
  if (start.stream > (first?.streams?.length ?? 0)) {
    throw new Error(
      `media source ${start.source} of ${what} lists ${first?.streams?.length ?? 0} streams, so streamStartIndex must not exceed that`,
    )
  }
  const listing = (
    shown: JsonObject[],
    next: MediaStart | undefined,
  ): JsonObject => ({
    ...identity,
    ...(shown.length < sources.length
      ? { MediaSourcesTotal: sources.length }
      : {}),
    ...(start.source > 0 ? { MediaSourcesStartIndex: start.source } : {}),
    MediaSources: shown,
    ...(next
      ? {
          mediaNext: {
            mediaSourceIndex: next.source,
            streamStartIndex: next.stream,
          },
        }
      : {}),
  })
  const shown: JsonObject[] = []
  for (let index = start.source; index < sources.length; index++) {
    const source = sources[index]
    if (source === undefined) break
    const from = index === start.source ? start.stream : 0
    const total = source.streams?.length ?? 0
    // Where the listing has got to once `count` more streams are in it.
    const after = (count: number): MediaStart | undefined =>
      from + count < total
        ? { source: index, stream: from + count }
        : index + 1 < sources.length
          ? { source: index + 1, stream: 0 }
          : undefined
    const count = largestFitting(total - from, (streams) =>
      fits(
        listing(
          [...shown, sourceListing(source, from, streams)],
          after(streams),
        ),
      ),
    )
    if (count < Math.min(1, total - from)) break
    shown.push(sourceListing(source, from, count))
    if (from + count < total) return listing(shown, after(count))
  }
  const reached = start.source + shown.length
  if (shown.length === 0 && first !== undefined) {
    const least = listing([sourceListing(first, start.stream, 1)], start)
    throw new Error(
      `stream ${start.stream} of media source ${start.source} of ${what} cannot be listed: with the item's identity it is ${JSON.stringify(least).length} characters, more than its result holds`,
    )
  }
  return fitted(
    listing(
      shown,
      reached < sources.length ? { source: reached, stream: 0 } : undefined,
    ),
    what,
    fits,
  )
}

/**
 * A listing with no stream left to cut. Throws when even that is too long,
 * which is an item whose identity alone outgrows its result.
 */
function fitted(
  item: JsonObject,
  what: string,
  fits: (item: JsonObject) => boolean,
): JsonObject {
  if (fits(item)) return item
  throw new Error(
    `${what} cannot be listed: without any stream it is ${JSON.stringify(item).length} characters, more than its result holds`,
  )
}

/**
 * The answer to an id read: what came back, in request order, and what did
 * not. Items are listed whole while they fit. One too long for a result of
 * its own is listed alone, as far as its media fits.
 */
export function itemsResult(
  ids: readonly string[],
  found: JsonObject[],
  start: MediaStart | undefined,
): JsonObject {
  const wanted = [...new Set(ids.map(itemKey))]
  const byId = new Map(found.map((item) => [itemKey(String(item.Id)), item]))
  const returned = wanted.flatMap((id) => {
    const item = byId.get(id)
    return item ? [{ id, item }] : []
  })
  const result = (items: JsonObject[]): JsonObject => ({
    requested: wanted.length,
    returned: returned.length,
    notReturned: wanted.filter((id) => !byId.has(id)),
    listed: items.length,
    ...(items.length < returned.length
      ? {
          truncated: true,
          notListed: returned.slice(items.length).map((entry) => entry.id),
        }
      : {}),
    items,
  })
  const fits = (items: JsonObject[]) =>
    JSON.stringify(result(items)).length <= MAX_RESULT_CHARS
  const first = returned[0]
  if (first === undefined) return result([])
  const alone = (from: MediaStart) =>
    result([mediaItem(first.item, from, (item) => fits([item]))])
  if (start !== undefined) return alone(start)
  const whole = returned.map((entry) =>
    mediaItem(entry.item, WHOLE_MEDIA, () => true),
  )
  const count = largestFitting(whole.length, (items) =>
    fits(whole.slice(0, items)),
  )
  return count > 0 ? result(whole.slice(0, count)) : alone(WHOLE_MEDIA)
}

/** Where an id read goes on in one item's media, when it asks to. */
export function mediaStart(params: {
  ids: readonly string[]
  mediaSourceIndex?: number | undefined
  streamStartIndex?: number | undefined
}): MediaStart | undefined {
  if (params.mediaSourceIndex === undefined) {
    if (params.streamStartIndex === undefined) return undefined
    throw new Error("pass streamStartIndex with the mediaSourceIndex it is in")
  }
  if (new Set(params.ids.map(itemKey)).size !== 1) {
    throw new Error(
      "mediaSourceIndex reads on in one item's media: pass that item's id alone",
    )
  }
  return {
    source: params.mediaSourceIndex,
    stream: params.streamStartIndex ?? 0,
  }
}
