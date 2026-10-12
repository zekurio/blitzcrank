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
  pickOrNull,
  type JsonObject,
} from "../json.ts"
import {
  action,
  defineReads,
  defineWrites,
  fittingCount,
  largestFitting,
  listResult,
  MAX_LIST_ITEMS,
  MAX_OUTCOME_PART_CHARS,
  MAX_RESULT_CHARS,
  resource,
  toolCheck,
  toolFail,
  type ServerTool,
  type ToolFailure,
  type WriteEffect,
} from "../tools.ts"

type Signal = AbortSignal | undefined

const ITEM_FIELDS = "MediaSources,Path,ProviderIds"
const LIST_FIELDS = "Path,ProviderIds"
/** What `item_detail` asks for beyond the fields Jellyfin always sends. */
const DETAIL_FIELDS =
  "People,Overview,Taglines,Genres,Tags,Studios,ProviderIds,Path,ParentId,OriginalTitle,SortName,DateCreated,DateLastMediaAdded,Settings"
/** A rematch refreshes the item, and for a series every child, before it answers. */
const REMATCH_TIMEOUT_MS = 90_000
/** A remote search asks every metadata provider of the item's library. */
const SEARCH_TIMEOUT_MS = 60_000
/**
 * A write has 45 s to resolve its target. The item read and the search a
 * rematch resolves with fit inside that together, so their own timeouts
 * report first.
 */
const RESOLVE_ITEM_TIMEOUT_MS = 8_000
const RESOLVE_SEARCH_TIMEOUT_MS = 35_000
const MAX_OVERVIEW_CHARS = 300
const MAX_DETAIL_OVERVIEW_CHARS = 2_000
const MAX_FIELD_CHARS = 500
const MAX_NAME_CHARS = 160
const MAX_TAGS = 40
const MAX_PROVIDER_IDS = 30
const MAX_REPEATED_PEOPLE = 20
/**
 * A write's read-back is cut at `MAX_OUTCOME_PART_CHARS`. The item it shows
 * stays under that with room for the verdict next to it.
 */
const READ_BACK_ITEM_CHARS = MAX_OUTCOME_PART_CHARS - 2_000
const REFRESH_MODES = [
  "None",
  "ValidationOnly",
  "Default",
  "FullRefresh",
] as const
const LIBRARY_ITEM_TYPES = [
  "Movie",
  "Series",
  "Season",
  "Episode",
  "BoxSet",
] as const
/** The item types Jellyfin has a remote search for that this server offers. */
const REMATCH_TYPES = ["Movie", "Series", "BoxSet", "Trailer"] as const
const PROVIDERS = ["Tmdb", "Tvdb", "Imdb"] as const
/** Jellyfin accepts an id with or without dashes and prints it without. */
const ID_PATTERN =
  "^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$"
const NOT_RETURNED =
  "Jellyfin answered 404 for this item as this user, and separate reads found the item and the user. " +
  "Library access and parental rules are what usually hide an item from a user. The answer names no cause, and an item or user that changed between those reads looks the same"

type RematchType = (typeof REMATCH_TYPES)[number]

export function buildJellyfinTools(cfg: ServiceConfig): ServerTool[] {
  const service = { name: "jellyfin", label: "Jellyfin (library)" }
  return [
    ...defineReads(service, jellyfinReads(cfg)),
    ...defineWrites(service, jellyfinActions(cfg)),
  ]
}

/**
 * Jellyfin 12 rejects the legacy X-Emby-Token header with HTTP 401 and
 * accepts the key only through the MediaBrowser Authorization scheme.
 */
function jellyfinRequest(
  cfg: ServiceConfig,
  path: string,
  opts: JsonRequestOptions = {},
) {
  return jsonRequestEffect<JsonValue | undefined>(cfg.url, path, {
    ...opts,
    headers: { Authorization: `MediaBrowser Token="${cfg.apiKey}"` },
  })
}

/** An `/Items` query. Bare `GET /Items/{id}` answers 400 without a user. */
function queryItems(
  cfg: ServiceConfig,
  query: NonNullable<JsonRequestOptions["query"]>,
  signal: Signal,
  timeoutMs?: number,
): Effect.Effect<{ items: JsonObject[]; total: number }, ToolFailure> {
  return jellyfinRequest(cfg, "/Items", { query, signal, timeoutMs }).pipe(
    Effect.flatMap((response) => toolCheck(() => itemPage(response))),
  )
}

/**
 * A list read is evidence of what exists, so a response that is not a list
 * with a count is an error, never an empty answer.
 */
function itemPage(response: JsonValue | undefined) {
  if (
    !isJsonObject(response) ||
    !Array.isArray(response.Items) ||
    !isNumber(response.TotalRecordCount)
  ) {
    throw new Error("jellyfin returned no item list with a total count")
  }
  const items = response.Items
  if (!items.every(isItem)) {
    throw new Error("jellyfin returned an item list entry without an Id")
  }
  return { items, total: response.TotalRecordCount }
}

function isItem(value: JsonValue): value is JsonObject {
  return isJsonObject(value) && isString(value.Id)
}

function itemKey(id: string): string {
  return id.replaceAll("-", "").toLowerCase()
}

/**
 * Items by id. Jellyfin 12 answers an `Ids` value it cannot parse by dropping
 * the filter and listing the library roots, so an answer is trusted only when
 * every item in it was asked for.
 */
function readItems(
  cfg: ServiceConfig,
  ids: readonly string[],
  fields: string,
  signal: Signal,
  timeoutMs?: number,
): Effect.Effect<JsonObject[], ToolFailure> {
  const wanted = new Set(ids.map(itemKey))
  return queryItems(
    cfg,
    { Ids: [...wanted].join(","), Fields: fields },
    signal,
    timeoutMs,
  ).pipe(
    Effect.flatMap((result) =>
      result.items.every((item) => wanted.has(itemKey(String(item.Id))))
        ? Effect.succeed(result.items)
        : toolFail(
            "jellyfin answered an id lookup with items that were not asked for; its id filter did not apply",
          ),
    ),
  )
}

/** One item, read without a user, so a miss is an item that does not exist. */
function readItem(
  cfg: ServiceConfig,
  itemId: string,
  signal: Signal,
  opts: { fields?: string; timeoutMs?: number } = {},
): Effect.Effect<JsonObject, ToolFailure> {
  return readItems(
    cfg,
    [itemId],
    opts.fields ?? ITEM_FIELDS,
    signal,
    opts.timeoutMs,
  ).pipe(
    Effect.flatMap((items) => {
      const item = items[0]
      return item
        ? Effect.succeed(item)
        : toolFail(`jellyfin has no item ${itemId}`)
    }),
  )
}

/**
 * One item as Jellyfin returns it to one user, or `undefined` when it answers
 * 404 for a user that exists. `GET /Items/{id}` with a user applies that
 * user's library access and parental rules. `GET /Items?Ids=` with a user
 * does not check library access under an API key, so it cannot answer this.
 */
function readUserItem(
  cfg: ServiceConfig,
  itemId: string,
  userId: string,
  signal: Signal,
): Effect.Effect<JsonObject | undefined, ToolFailure> {
  return jellyfinRequest(cfg, `/Items/${itemKey(itemId)}`, {
    query: { userId: itemKey(userId) },
    signal,
  }).pipe(
    Effect.flatMap(
      (item): Effect.Effect<JsonObject | undefined, ToolFailure> =>
        isJsonObject(item) &&
        isString(item.Id) &&
        itemKey(item.Id) === itemKey(itemId)
          ? Effect.succeed(item)
          : toolFail(
              `jellyfin returned no record of item ${itemId} for user ${userId}`,
            ),
    ),
    Effect.catchTag(
      "HttpError",
      (error): Effect.Effect<JsonObject | undefined, ToolFailure> =>
        error.status === 404
          ? // An unknown user answers the same 404, so that is ruled out.
            requireUser(cfg, userId, signal).pipe(Effect.as(undefined))
          : Effect.fail(error),
    ),
  )
}

function requireUser(
  cfg: ServiceConfig,
  userId: string,
  signal: Signal,
): Effect.Effect<void, ToolFailure> {
  return jellyfinRequest(cfg, `/Users/${itemKey(userId)}`, { signal }).pipe(
    Effect.catchTag(
      "HttpError",
      (error): Effect.Effect<never, ToolFailure> =>
        error.status === 404
          ? toolFail(`jellyfin has no user ${userId}`)
          : Effect.fail(error),
    ),
    Effect.asVoid,
  )
}

/**
 * A bounded scalar: a string cut to `max` characters that says how much was
 * cut, a number or boolean as it is, and `null` for anything else. A named
 * field that arrives as a nested record is therefore never passed on whole.
 */
function clip(value: JsonValue | undefined, max: number): JsonValue {
  if (isNumber(value) || typeof value === "boolean") return value
  if (!isString(value)) return null
  if (value.length <= max) return value
  return `${value.slice(0, max)}... [${value.length - max} more chars]`
}

/** Bounds every field of a projection that is already a reviewed field set. */
function clipStrings(record: JsonObject, max = MAX_FIELD_CHARS): JsonObject {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, clip(value, max)]),
  )
}

/**
 * A `ProviderIds` value as a bounded map of strings: `undefined` when Jellyfin
 * sent none, `"malformed"` when it sent something else in its place.
 */
function parseProviderIds(
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
function providerIdsOf(
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
function compactStream(stream: JsonObject): JsonObject {
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
function compactItem(item: JsonObject): JsonObject {
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

const WHOLE_MEDIA: MediaStart = { source: 0, stream: 0 }

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
function mediaItem(
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
function itemsResult(
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
function mediaStart(params: {
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

const DETAIL_SCALARS = [
  "Id",
  "Name",
  "OriginalTitle",
  "SortName",
  "Type",
  "MediaType",
  "IsFolder",
  "LocationType",
  "Path",
  "ParentId",
  "SeriesId",
  "SeriesName",
  "SeasonId",
  "SeasonName",
  "IndexNumber",
  "IndexNumberEnd",
  "ParentIndexNumber",
  "ProductionYear",
  "PremiereDate",
  "EndDate",
  "DateCreated",
  "DateLastMediaAdded",
  "Status",
  "AirTime",
  "OfficialRating",
  "CommunityRating",
  "CriticRating",
  "RunTimeTicks",
  "OriginalLanguage",
  "LockData",
] as const

const USER_DATA = [
  "Played",
  "PlayCount",
  "PlaybackPositionTicks",
  "PlayedPercentage",
  "UnplayedItemCount",
  "IsFavorite",
  "LastPlayedDate",
] as const

/**
 * The reviewed diagnostic projection of one item. Only named fields leave
 * here, so a field a later Jellyfin adds never reaches the model unreviewed.
 */
function itemDetail(
  item: JsonObject,
  peopleStart: number,
  userView: JsonObject | undefined,
): JsonObject {
  const what = `item ${String(item.Id)}`
  const partial: string[] = []
  // `null` is a list Jellyfin did not send. One in another shape throws: a
  // dropped entry would leave a shorter list that reads as the whole one.
  const strings = (name: string, value: JsonValue | undefined): JsonValue => {
    if (value === undefined || value === null) return null
    if (!Array.isArray(value) || !value.every(isString)) {
      throw new Error(`jellyfin returned a malformed ${name} list for ${what}`)
    }
    if (value.length > MAX_TAGS) {
      partial.push(`${name} lists ${MAX_TAGS} of ${value.length}`)
    }
    return value.slice(0, MAX_TAGS).map((entry) => clip(entry, 100))
  }
  const people = peopleOf(item, what)
  const repeated = repeatedPeople(people ?? [])
  if (repeated !== null && repeated.length > MAX_REPEATED_PEOPLE) {
    partial.push(
      `People.repeated lists ${MAX_REPEATED_PEOPLE} of ${repeated.length}`,
    )
  }
  const base: JsonObject = {
    ...clipStrings(pickOrNull(item, DETAIL_SCALARS)),
    ProviderIds: providerIdsOf(item, what) ?? null,
    Overview: clip(item.Overview, MAX_DETAIL_OVERVIEW_CHARS),
    Taglines: strings("Taglines", item.Taglines),
    Genres: strings("Genres", item.Genres),
    Tags: strings("Tags", item.Tags),
    Studios: strings("Studios", studioNames(item, what)),
    AirDays: strings("AirDays", item.AirDays),
    LockedFields: strings("LockedFields", item.LockedFields),
    ...(userView ? { userView } : {}),
  }
  const page = people?.slice(peopleStart, peopleStart + MAX_LIST_ITEMS) ?? []
  const withPeople = (count: number): JsonObject => ({
    ...base,
    People: people
      ? {
          total: people.length,
          listed: count,
          ...(peopleStart > 0 ? { startIndex: peopleStart } : {}),
          ...(peopleStart + count < people.length
            ? { nextStartIndex: peopleStart + count }
            : {}),
          repeated: repeated?.slice(0, MAX_REPEATED_PEOPLE) ?? null,
          items: page.slice(0, count).map(compactPerson),
        }
      : null,
    ...(partial.length > 0 ? { partial } : {}),
  })
  return withPeople(
    fittingCount(page.length, withPeople, {
      entry: `the People entry at index ${peopleStart}`,
    }),
  )
}

/** Studio names, or `undefined` when Jellyfin sent no studio list. */
function studioNames(item: JsonObject, what: string): JsonValue | undefined {
  const studios = item.Studios
  if (studios === undefined || studios === null) return undefined
  const malformed = `jellyfin returned a malformed Studios list for ${what}`
  if (!Array.isArray(studios)) throw new Error(malformed)
  return studios.map((studio) => {
    if (!isJsonObject(studio) || !isString(studio.Name)) {
      throw new Error(malformed)
    }
    return studio.Name
  })
}

/** Cast and crew in Jellyfin's order, or `undefined` when it sent no list. */
function peopleOf(item: JsonObject, what: string): JsonObject[] | undefined {
  const people = item.People
  if (people === undefined || people === null) return undefined
  if (!Array.isArray(people) || !people.every(isJsonObject)) {
    throw new Error(`jellyfin returned a malformed People list for ${what}`)
  }
  return people
}

function compactPerson(person: JsonObject): JsonObject {
  return clipStrings(
    pickOrNull(person, ["Id", "Name", "Role", "Type"]),
    MAX_NAME_CHARS,
  )
}

/**
 * People listed more than once under one person Id, counted over the whole
 * list. One page of it cannot show that. `null` when an entry carries no Id
 * to count by, which leaves the repeats unknown.
 */
function repeatedPeople(people: readonly JsonObject[]): JsonObject[] | null {
  const counts = new Map<string, { name: JsonValue; entries: number }>()
  for (const person of people) {
    if (!isString(person.Id)) return null
    counts.set(person.Id, {
      name: clip(person.Name, MAX_NAME_CHARS),
      entries: (counts.get(person.Id)?.entries ?? 0) + 1,
    })
  }
  return [...counts]
    .filter(([, seen]) => seen.entries > 1)
    .map(([id, seen]) => ({ Id: id, Name: seen.name, entries: seen.entries }))
}

/** Whether Jellyfin returns the item to one user, and that user's state on it. */
function userViewOf(userId: string, seen: JsonObject | undefined): JsonObject {
  if (seen === undefined) {
    return { userId, returned: false, meaning: NOT_RETURNED }
  }
  const userData = objectField(seen, "UserData")
  return {
    userId,
    returned: true,
    UserData: userData ? clipStrings(pickOrNull(userData, USER_DATA)) : null,
    ...clipStrings(pickOrNull(seen, ["ChildCount", "RecursiveItemCount"])),
  }
}

function itemLabel(item: JsonObject): string {
  return `${String(item.Type ?? "item")} ${String(item.Name ?? "unnamed")} (${String(item.Id)})`
}

interface SearchSeed {
  name?: string | undefined
  year?: number | undefined
  provider?: string | undefined
  providerId?: string | undefined
}

/** What an Apply consumes of a candidate, validated. */
interface Candidate {
  Name: string | undefined
  ProductionYear: number | undefined
  SearchProviderName: string | undefined
  ProviderIds: Record<string, string>
}

function rematchType(
  item: JsonObject,
): Effect.Effect<RematchType, ToolFailure> {
  const type = REMATCH_TYPES.find((entry) => entry === item.Type)
  return type
    ? Effect.succeed(type)
    : toolFail(
        `${itemLabel(item)} has no remote search of its own: Jellyfin matches ${REMATCH_TYPES.join(", ")}. For a season or episode, match its series`,
      )
}

/**
 * Asks the item's metadata providers for candidates. The request is built
 * here from named inputs. It changes nothing in Jellyfin.
 */
function remoteSearch(
  cfg: ServiceConfig,
  type: RematchType,
  seed: SearchSeed,
  itemId: string | undefined,
  signal: Signal,
  timeoutMs: number,
): Effect.Effect<JsonValue[], ToolFailure> {
  return jellyfinRequest(cfg, `/Items/RemoteSearch/${type}`, {
    method: "POST",
    body: {
      SearchInfo: {
        ...(seed.name !== undefined ? { Name: seed.name } : {}),
        ...(seed.year !== undefined ? { Year: seed.year } : {}),
        ...(seed.provider !== undefined && seed.providerId !== undefined
          ? { ProviderIds: { [seed.provider]: seed.providerId } }
          : {}),
      },
      ...(itemId !== undefined ? { ItemId: itemKey(itemId) } : {}),
    },
    timeoutMs,
    signal,
  }).pipe(
    Effect.flatMap((response) =>
      Array.isArray(response)
        ? Effect.succeed(response)
        : toolFail("jellyfin returned no candidate list"),
    ),
  )
}

/** The fields an Apply consumes, or `undefined` when any of them is malformed. */
function candidateOf(entry: JsonValue): Candidate | undefined {
  if (!isJsonObject(entry)) return undefined
  const name = entry.Name ?? undefined
  const year = entry.ProductionYear ?? undefined
  const source = entry.SearchProviderName ?? undefined
  const ids = parseProviderIds(entry.ProviderIds)
  if (
    (name !== undefined && !isShortString(name)) ||
    (year !== undefined && !Number.isInteger(year)) ||
    (source !== undefined && !isShortString(source)) ||
    ids === undefined ||
    ids === "malformed" ||
    Object.keys(ids).length === 0
  ) {
    return undefined
  }
  return {
    Name: isString(name) ? name : undefined,
    ProductionYear: isNumber(year) ? year : undefined,
    SearchProviderName: isString(source) ? source : undefined,
    ProviderIds: ids,
  }
}

function isShortString(value: JsonValue): boolean {
  return isString(value) && value.length <= MAX_FIELD_CHARS
}

function providerIdOf(
  ids: Record<string, string>,
  provider: string,
): string | undefined {
  // Jellyfin compares provider names without regard to case.
  const key = Object.keys(ids).find(
    (name) => name.toLowerCase() === provider.toLowerCase(),
  )
  return key === undefined ? undefined : ids[key]
}

function candidateLabel(candidate: Candidate): string {
  return `${candidate.Name ?? "unnamed"} (${String(candidate.ProductionYear ?? "unknown year")}) from ${candidate.SearchProviderName ?? "an unnamed search provider"} with provider ids ${JSON.stringify(candidate.ProviderIds)}`
}

/** One candidate as a search lists it. Nothing of it is passed through whole. */
function compactCandidate(entry: JsonValue): JsonObject {
  const candidate = candidateOf(entry)
  const raw = isJsonObject(entry) ? entry : undefined
  return {
    Name: clip(raw?.Name, MAX_NAME_CHARS),
    ProductionYear: clip(raw?.ProductionYear, 40),
    PremiereDate: clip(raw?.PremiereDate, 40),
    SearchProviderName: clip(raw?.SearchProviderName, MAX_NAME_CHARS),
    ProviderIds: candidate?.ProviderIds ?? null,
    Overview: clip(raw?.Overview, MAX_OVERVIEW_CHARS),
    ...(candidate ? {} : { malformed: true }),
  }
}

/**
 * The one live candidate carrying a provider id, as the request an Apply
 * sends. No candidate, an unreadable one, or several that differ fail here,
 * before anything is written.
 */
function exactCandidate(
  found: readonly JsonValue[],
  wanted: {
    provider: string
    providerId: string
    searchProviderName?: string | undefined
  },
): Candidate {
  const identity = `${wanted.provider} ${wanted.providerId}`
  const candidates = found.map(candidateOf)
  const unreadable = candidates.filter((entry) => entry === undefined).length
  if (unreadable > 0) {
    throw new Error(
      `${unreadable} of ${found.length} candidates came back in a shape that cannot be checked, so the match for ${identity} is not established; nothing was written`,
    )
  }
  const carrying = candidates.flatMap((entry) =>
    entry &&
    providerIdOf(entry.ProviderIds, wanted.provider) === wanted.providerId
      ? [entry]
      : [],
  )
  const matching = carrying.filter(
    (entry) =>
      wanted.searchProviderName === undefined ||
      entry.SearchProviderName === wanted.searchProviderName,
  )
  // Two providers can return the same title; identical requests are one.
  const distinct = [
    ...new Map(matching.map((entry) => [canonical(entry), entry])).values(),
  ]
  const only = distinct[0]
  if (only !== undefined && distinct.length === 1) return only
  if (distinct.length > 1) {
    throw new Error(
      `${distinct.length} different candidates carry ${identity}: ${distinct.map(candidateLabel).join(" | ")}. Nothing was written. ${
        wanted.searchProviderName === undefined
          ? "Pass the searchProviderName of the one to apply"
          : "They share that search provider, so this tool cannot choose between them"
      }`,
    )
  }
  throw new Error(
    carrying.length > 0
      ? `no candidate with ${identity} comes from search provider ${String(wanted.searchProviderName)}; it is offered by ${carrying.map((entry) => entry.SearchProviderName ?? "an unnamed provider").join(", ")}. Nothing was written`
      : `no metadata provider returned a candidate with ${identity} just now (${found.length} other candidates). Nothing was written; read jellyfin_remote_search with that provider and providerId`,
  )
}

function canonical(candidate: Candidate): string {
  return JSON.stringify([
    candidate.Name,
    candidate.ProductionYear,
    candidate.SearchProviderName,
    Object.entries(candidate.ProviderIds).toSorted(([a], [b]) =>
      a.localeCompare(b),
    ),
  ])
}

/** Whether the item reads back with every provider id the rematch applied. */
function rematchReadBack(
  item: JsonObject,
  expected: Record<string, string>,
): JsonValue {
  const actual = providerIdsOf(item, `item ${String(item.Id)}`) ?? {}
  const differing = Object.entries(expected).flatMap(([provider, id]) =>
    providerIdOf(actual, provider) === id ? [] : [provider],
  )
  return differing.length === 0
    ? {
        confirmed: "the applied provider ids read back",
        item: readBackItem(item),
      }
    : {
        warning: `read-back differs from the applied provider ids in ${differing.join(", ")}`,
        item: readBackItem(item),
      }
}

/** The item a write reads back, with as much of its media as that holds. */
function readBackItem(item: JsonObject): JsonObject {
  return mediaItem(
    item,
    WHOLE_MEDIA,
    (listed) => JSON.stringify(listed).length <= READ_BACK_ITEM_CHARS,
  )
}

const itemIdParam = Type.String({
  pattern: ID_PATTERN,
  description: "Jellyfin item id, 32 hex digits",
})
const userIdParam = Type.String({
  pattern: ID_PATTERN,
  description:
    "Jellyfin user id, 32 hex digits, from jellyfin_users or a Seerr user's jellyfinUserId. Never pick a user by display name",
})
const providerParam = Type.Enum(PROVIDERS, {
  description: "The metadata provider the id belongs to",
})
const providerIdParam = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z0-9._-]+$",
  description:
    "The id at that provider, e.g. 603 for Tmdb or tt0133093 for Imdb",
})

function jellyfinReads(cfg: ServiceConfig) {
  return {
    search: resource({
      description: "Find library items by name",
      params: Type.Object({
        term: Type.String({ minLength: 1 }),
        includeItemTypes: Type.Optional(
          Type.Array(Type.Enum(LIBRARY_ITEM_TYPES), { minItems: 1 }),
        ),
      }),
      run: (params, signal) =>
        queryItems(
          cfg,
          {
            searchTerm: params.term,
            Recursive: true,
            IncludeItemTypes: params.includeItemTypes?.join(","),
            Fields: LIST_FIELDS,
            Limit: MAX_LIST_ITEMS,
          },
          signal,
        ).pipe(
          Effect.map((result) =>
            listResult(result.items.map(compactItem), { total: result.total }),
          ),
        ),
    }),
    items: resource({
      description:
        "Items by id with path, location type, provider ids, media sources, and streams. " +
        "notReturned names every requested id Jellyfin has no item for. A null field is one Jellyfin did not send, not a finding that it is absent. " +
        "An item whose media does not fit one result is listed alone as far as it fits and carries mediaNext: read that id again by itself with those two values for the rest",
      params: Type.Object({
        ids: Type.Array(itemIdParam, { minItems: 1, maxItems: 50 }),
        mediaSourceIndex: Type.Optional(
          Type.Integer({
            minimum: 0,
            description:
              "With one id only: list its media sources from this one on; an item's mediaNext",
          }),
        ),
        streamStartIndex: Type.Optional(
          Type.Integer({
            minimum: 0,
            description:
              "With mediaSourceIndex: skip this many streams of that source; an item's mediaNext",
          }),
        ),
      }),
      run: (params, signal) =>
        Effect.gen(function* () {
          const start = yield* toolCheck(() => mediaStart(params))
          const found = yield* readItems(cfg, params.ids, ITEM_FIELDS, signal)
          return yield* toolCheck(() => itemsResult(params.ids, found, start))
        }),
    }),
    item_detail: resource({
      description:
        "One item's metadata for diagnosis: identity, provider ids, dates, status, ratings, genres, tags, lock state, and its cast and crew in Jellyfin's order with repeated entries kept. " +
        "With userId, also whether Jellyfin returns the item to that user and their played state, progress, favorite flag, and child counts. " +
        "A null field is one Jellyfin did not send",
      params: Type.Object({
        itemId: itemIdParam,
        userId: Type.Optional(userIdParam),
        peopleStartIndex: Type.Optional(
          Type.Integer({
            minimum: 0,
            description: "Skip this many People entries; People.nextStartIndex",
          }),
        ),
      }),
      run: (params, signal) =>
        Effect.gen(function* () {
          // Read without a user first: only that proves the item exists.
          const item = yield* readItem(cfg, params.itemId, signal, {
            fields: DETAIL_FIELDS,
          })
          const userId = params.userId
          const userView =
            userId === undefined
              ? undefined
              : userViewOf(
                  userId,
                  yield* readUserItem(cfg, params.itemId, userId, signal),
                )
          return yield* toolCheck(() =>
            itemDetail(item, params.peopleStartIndex ?? 0, userView),
          )
        }),
    }),
    children: resource({
      description:
        "Direct children of a library, series, or season as Jellyfin lists them, each with IndexNumber and LocationType. Virtual is a placeholder without a file. " +
        "With userId, the children Jellyfin returns to that user, with their played state: a series then lists no season without a file unless the user displays missing episodes",
      params: Type.Object({
        parentId: itemIdParam,
        userId: Type.Optional(userIdParam),
        startIndex: Type.Optional(
          Type.Integer({
            minimum: 0,
            description: "The nextStartIndex of a truncated result",
          }),
        ),
      }),
      run: (params, signal) =>
        Effect.gen(function* () {
          const userId = params.userId
          if (userId !== undefined) {
            // Under an API key Jellyfin lists a parent's children for any
            // user without checking that the user may see the parent.
            const parent = yield* readUserItem(
              cfg,
              params.parentId,
              userId,
              signal,
            )
            if (parent === undefined) {
              // Fails here when the parent does not exist for anyone.
              yield* readItem(cfg, params.parentId, signal)
              return {
                userView: {
                  userId,
                  parentReturned: false,
                  meaning: NOT_RETURNED,
                },
              }
            }
          }
          const result = yield* queryItems(
            cfg,
            {
              ParentId: itemKey(params.parentId),
              userId: userId === undefined ? undefined : itemKey(userId),
              Fields: LIST_FIELDS,
              // Jellyfin sorts a series' seasons by name whatever is asked.
              SortBy: "ParentIndexNumber,IndexNumber,SortName",
              StartIndex: params.startIndex,
              Limit: MAX_LIST_ITEMS,
            },
            signal,
          ).pipe(
            Effect.catchTag(
              "HttpError",
              (error): Effect.Effect<never, ToolFailure> =>
                // An unknown parent answers 400 with no reason.
                error.status === 400
                  ? readItem(cfg, params.parentId, signal).pipe(
                      Effect.flatMap(() => Effect.fail(error)),
                    )
                  : Effect.fail(error),
            ),
          )
          const start = params.startIndex ?? 0
          const items = result.items.map((item) => ({
            ...compactItem(item),
            ...(userId !== undefined
              ? {
                  UserData: clipStrings(
                    pickOrNull(objectField(item, "UserData"), [
                      "Played",
                      "PlaybackPositionTicks",
                      "UnplayedItemCount",
                      "IsFavorite",
                    ]),
                  ),
                }
              : {}),
          }))
          // A season of long paths outgrows one result, so the page ends at
          // the last child that fits.
          const withCount = (count: number): JsonObject => ({
            ...(userId !== undefined
              ? { userView: { userId, parentReturned: true } }
              : {}),
            total: result.total,
            listed: count,
            ...(start > 0 ? { startIndex: start } : {}),
            ...(start + count < result.total
              ? { truncated: true, nextStartIndex: start + count }
              : {}),
            items: items.slice(0, count),
          })
          return yield* toolCheck(() =>
            withCount(
              fittingCount(items.length, withCount, {
                entry: `the child at startIndex ${start}`,
              }),
            ),
          )
        }),
    }),
    by_provider_id: resource({
      description:
        "Items of one type whose provider id matches, e.g. Tmdb 603 for a Movie",
      params: Type.Object({
        provider: providerParam,
        id: providerIdParam,
        itemType: Type.Enum(LIBRARY_ITEM_TYPES),
      }),
      run: (params, signal) =>
        Effect.gen(function* () {
          const result = yield* queryItems(
            cfg,
            {
              Recursive: true,
              IncludeItemTypes: params.itemType,
              AnyProviderIdEquals: `${params.provider}.${params.id}`,
              Fields: ITEM_FIELDS,
              Limit: 200,
            },
            signal,
          )
          // The server's filter is not trusted to exist on every version.
          const matching = result.items.filter((item) =>
            Object.entries(objectField(item, "ProviderIds") ?? {}).some(
              ([provider, id]) =>
                provider.toLowerCase() === params.provider.toLowerCase() &&
                String(id) === params.id,
            ),
          )
          return {
            ...listResult(matching.map(compactItem)),
            ...(matching.length < result.items.length &&
            result.total > result.items.length
              ? {
                  warning: `this Jellyfin ignored the provider filter; only the first ${result.items.length} of ${result.total} ${params.itemType} items were checked`,
                }
              : {}),
          }
        }),
    }),
    libraries: resource({
      description: "Libraries with their type and folders on disk",
      params: Type.Object({}),
      run: (_params, signal) =>
        jellyfinRequest(cfg, "/Library/VirtualFolders", { signal }).pipe(
          Effect.map((response) =>
            listResult(
              objectList(response).map((library) =>
                pick(library, [
                  "Name",
                  "CollectionType",
                  "ItemId",
                  "Locations",
                ]),
              ),
            ),
          ),
        ),
    }),
    users: resource({
      description:
        "Users with their library access and audio and subtitle preferences",
      params: Type.Object({}),
      run: (_params, signal) =>
        jellyfinRequest(cfg, "/Users", { signal }).pipe(
          Effect.map((response) =>
            listResult(
              objectList(response).map((user) => ({
                ...pick(user, ["Id", "Name", "LastActivityDate"]),
                Policy: pick(objectField(user, "Policy"), [
                  "IsAdministrator",
                  "IsDisabled",
                  "EnableAllFolders",
                  "EnabledFolders",
                  "EnableMediaPlayback",
                  "EnableVideoPlaybackTranscoding",
                ]),
                Configuration: pick(objectField(user, "Configuration"), [
                  "AudioLanguagePreference",
                  "PlayDefaultAudioTrack",
                  "SubtitleLanguagePreference",
                  "SubtitleMode",
                ]),
              })),
            ),
          ),
        ),
    }),
    sessions: resource({
      description:
        "Active sessions with what plays, the play method, and transcode reasons",
      params: Type.Object({}),
      run: (_params, signal) =>
        jellyfinRequest(cfg, "/Sessions", { signal }).pipe(
          Effect.map((response) =>
            listResult(
              objectList(response).map((session) => {
                const playing = objectField(session, "NowPlayingItem")
                return {
                  ...pick(session, [
                    "Id",
                    "UserId",
                    "UserName",
                    "Client",
                    "DeviceName",
                    "ApplicationVersion",
                    "LastActivityDate",
                  ]),
                  ...(playing ? { NowPlayingItem: compactItem(playing) } : {}),
                  PlayState: pick(objectField(session, "PlayState"), [
                    "PlayMethod",
                    "IsPaused",
                    "PositionTicks",
                    "MediaSourceId",
                    "AudioStreamIndex",
                    "SubtitleStreamIndex",
                  ]),
                  TranscodingInfo: pick(
                    objectField(session, "TranscodingInfo"),
                    [
                      "IsVideoDirect",
                      "IsAudioDirect",
                      "VideoCodec",
                      "AudioCodec",
                      "Container",
                      "TranscodeReasons",
                      "HardwareAccelerationType",
                    ],
                  ),
                }
              }),
            ),
          ),
        ),
    }),
    server_info: resource({
      description:
        "Jellyfin's version, and whether it waits for a restart, is shutting down, or has an update",
      params: Type.Object({}),
      run: (_params, signal) =>
        jellyfinRequest(cfg, "/System/Info", { signal }).pipe(
          Effect.flatMap((info) =>
            isJsonObject(info) && isString(info.Version)
              ? Effect.succeed({
                  Version: clip(info.Version, 40),
                  ...clipStrings(
                    pickOrNull(info, [
                      "ProductName",
                      "HasPendingRestart",
                      "IsShuttingDown",
                      "HasUpdateAvailable",
                    ]),
                    100,
                  ),
                })
              : toolFail("jellyfin returned no version"),
          ),
        ),
    }),
    remote_search: resource({
      description:
        "Metadata-provider match candidates for an item, by name and year or by one provider id. Queries providers and changes nothing. " +
        "With neither name nor provider id, the item's own name and year are searched",
      params: Type.Object({
        itemId: Type.Optional(itemIdParam),
        itemType: Type.Optional(
          Type.Enum(REMATCH_TYPES, {
            description: "Only without itemId; the item's own type otherwise",
          }),
        ),
        name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        year: Type.Optional(Type.Integer({ minimum: 1870, maximum: 2200 })),
        provider: Type.Optional(providerParam),
        providerId: Type.Optional(providerIdParam),
      }),
      run: (params, signal) =>
        Effect.gen(function* () {
          if (
            (params.provider === undefined) !==
            (params.providerId === undefined)
          ) {
            return yield* toolFail("pass provider and providerId together")
          }
          const item =
            params.itemId === undefined
              ? undefined
              : yield* readItem(cfg, params.itemId, signal)
          const type = item ? yield* rematchType(item) : params.itemType
          if (type === undefined) {
            return yield* toolFail(
              "pass itemId, or itemType to search without one",
            )
          }
          if (params.itemType !== undefined && params.itemType !== type) {
            return yield* toolFail(
              `itemType ${params.itemType} does not match ${item ? itemLabel(item) : "the item"}; omit it with itemId`,
            )
          }
          // A mismatched item carries the wrong provider ids, so only its
          // name and year seed the default search.
          const own = params.name === undefined && params.provider === undefined
          const name = own ? item?.Name : params.name
          const year = own ? (params.year ?? item?.ProductionYear) : params.year
          if (own && !isString(name)) {
            return yield* toolFail(
              "pass name, or provider with providerId, or the itemId of an item that has a name",
            )
          }
          const seed: SearchSeed = {
            name: isString(name) ? name : undefined,
            year: isNumber(year) ? year : undefined,
            provider: params.provider,
            providerId: params.providerId,
          }
          const found = yield* remoteSearch(
            cfg,
            type,
            seed,
            params.itemId,
            signal,
            SEARCH_TIMEOUT_MS,
          )
          return {
            searched: { itemType: type, ...pick({ ...seed }, SEED_KEYS) },
            ...listResult(found.map(compactCandidate)),
          }
        }),
    }),
  }
}

const SEED_KEYS = ["name", "year", "provider", "providerId"] as const

function jellyfinActions(cfg: ServiceConfig) {
  return {
    refresh_item: action({
      description:
        "Refresh one item's metadata, images, and file probe. Runs in the background",
      params: Type.Object({
        itemId: itemIdParam,
        metadataRefreshMode: Type.Optional(
          Type.Enum(REFRESH_MODES, { description: "Default: Default" }),
        ),
        imageRefreshMode: Type.Optional(
          Type.Enum(REFRESH_MODES, { description: "Default: Default" }),
        ),
        replaceAllMetadata: Type.Optional(
          Type.Boolean({ description: "Discard the stored metadata first" }),
        ),
        replaceAllImages: Type.Optional(
          Type.Boolean({ description: "Discard the stored artwork first" }),
        ),
      }),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const item = yield* readItem(cfg, params.itemId, signal)
          const effect: WriteEffect = {
            kind: "refresh",
            target: itemLabel(item),
            detail: [
              `path ${String(item.Path ?? "none")}`,
              `metadata ${params.metadataRefreshMode ?? "Default"}`,
              `images ${params.imageRefreshMode ?? "Default"}`,
            ].join("; "),
          }
          return {
            state: null,
            summary: `Refresh ${itemLabel(item)}`,
            effects: [effect],
            warnings: [
              ...(params.replaceAllMetadata === true
                ? ["the stored metadata is replaced, manual edits included"]
                : []),
              ...(params.replaceAllImages === true
                ? ["the stored artwork is replaced"]
                : []),
            ],
          }
        }),
      write: (params) =>
        jellyfinRequest(cfg, `/Items/${itemKey(params.itemId)}/Refresh`, {
          method: "POST",
          query: {
            Recursive: true,
            MetadataRefreshMode: params.metadataRefreshMode ?? "Default",
            ImageRefreshMode: params.imageRefreshMode ?? "Default",
            ReplaceAllMetadata: params.replaceAllMetadata ?? false,
            ReplaceAllImages: params.replaceAllImages ?? false,
          },
        }).pipe(
          Effect.map(
            (): JsonValue => ({
              queued: "refresh accepted; Jellyfin runs it in the background",
            }),
          ),
        ),
      verify: (params) =>
        readItem(cfg, params.itemId, undefined).pipe(
          Effect.flatMap((item) => toolCheck(() => readBackItem(item))),
        ),
    }),
    apply_remote_search: action({
      description:
        "Rematch one item to the metadata-provider candidate carrying a provider id, replacing its provider ids and all of its metadata. " +
        "It searches the providers again and applies only a candidate they return now. " +
        "Jellyfin answers once it has refreshed the item, and for a series every season and episode. A long series can outlast that wait: the call then ends with an unknown outcome, which stops the run for operator review and is never retried",
      params: Type.Object({
        itemId: itemIdParam,
        provider: providerParam,
        providerId: providerIdParam,
        searchProviderName: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 100,
            description:
              "Only when several different candidates carry that id: the SearchProviderName of the one to apply",
          }),
        ),
        replaceAllImages: Type.Optional(
          Type.Boolean({ description: "Default true" }),
        ),
      }),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const item = yield* readItem(cfg, params.itemId, signal, {
            timeoutMs: RESOLVE_ITEM_TIMEOUT_MS,
          })
          const type = yield* rematchType(item)
          const found = yield* remoteSearch(
            cfg,
            type,
            { provider: params.provider, providerId: params.providerId },
            params.itemId,
            signal,
            RESOLVE_SEARCH_TIMEOUT_MS,
          )
          const candidate = yield* toolCheck(() =>
            exactCandidate(found, params),
          )
          const current = yield* toolCheck(() =>
            providerIdsOf(item, itemLabel(item)),
          )
          const match = `${candidate.Name ?? "unnamed"} (${String(candidate.ProductionYear ?? "unknown year")})`
          const rematch: WriteEffect = {
            kind: "rematch",
            target: itemLabel(item),
            detail: [
              `path ${String(item.Path ?? "none")}`,
              `provider ids ${current ? JSON.stringify(current) : "unknown"} replaced by ${JSON.stringify(candidate.ProviderIds)}`,
              `new match ${match} from ${candidate.SearchProviderName ?? "an unnamed search provider"}`,
              (params.replaceAllImages ?? true)
                ? "all images replaced"
                : "images kept",
            ].join("; "),
          }
          const children: WriteEffect = {
            kind: "refresh",
            target: `every season and episode of ${itemLabel(item)}`,
            detail: "metadata and images refreshed from the new match",
          }
          return {
            state: { candidate },
            summary: `Rematch ${itemLabel(item)} to ${match}`,
            effects: item.Type === "Series" ? [rematch, children] : [rematch],
            warnings: [
              "all metadata of the item is replaced by the new match",
              ...(item.Type === "Series"
                ? ["a series rematch also refreshes every season and episode"]
                : []),
            ],
          }
        }),
      write: (params, state) =>
        jellyfinRequest(
          cfg,
          `/Items/RemoteSearch/Apply/${itemKey(params.itemId)}`,
          {
            method: "POST",
            query: { ReplaceAllImages: params.replaceAllImages ?? true },
            // Only what an Apply reads, each from the live candidate.
            body: {
              ...(state.candidate.Name !== undefined
                ? { Name: state.candidate.Name }
                : {}),
              ...(state.candidate.ProductionYear !== undefined
                ? { ProductionYear: state.candidate.ProductionYear }
                : {}),
              ...(state.candidate.SearchProviderName !== undefined
                ? { SearchProviderName: state.candidate.SearchProviderName }
                : {}),
              ProviderIds: state.candidate.ProviderIds,
            },
            timeoutMs: REMATCH_TIMEOUT_MS,
          },
        ).pipe(Effect.map((): JsonValue => ({ applied: "rematch accepted" }))),
      verify: (params, _result, state) =>
        readItem(cfg, params.itemId, undefined).pipe(
          Effect.flatMap((item) =>
            toolCheck(() => rematchReadBack(item, state.candidate.ProviderIds)),
          ),
        ),
    }),
  }
}
