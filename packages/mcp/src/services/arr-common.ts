import { Effect } from "effect"
import { Type, type TObject } from "typebox"

import type { ServiceConfig } from "../config.ts"
import {
  jsonRequestEffect,
  type JsonRequestError,
  type JsonRequestOptions,
  type JsonValue,
} from "../http.ts"
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
} from "../json.ts"
import {
  action,
  fittingCount,
  keptRead,
  largestFitting,
  listResult,
  MAX_LIST_ITEMS,
  MAX_RESULT_CHARS,
  resource,
  toolCheck,
  ToolError,
  toolFail,
  type ToolFailure,
  type WriteEffect,
} from "../tools.ts"

/** What differs between the two Arrs for the tools they share. */
export interface Arr {
  service: "sonarr" | "radarr"
  cfg: ServiceConfig
  /** The id a queue, history, or blocklist record points back to. */
  itemKey: "seriesId" | "movieId"
  itemNoun: "series" | "movie"
  unknownItemsParam: "includeUnknownSeriesItems" | "includeUnknownMovieItems"
  itemHistoryPath: "/api/v3/history/series" | "/api/v3/history/movie"
  /**
   * How a download client's settings name this Arr's category, post-import
   * category, and directory: `tvCategory` or `movieCategory`, and so on.
   */
  clientSettingPrefix: "tv" | "movie"
  /** The command that scans a folder and imports what the Arr accepts. */
  scanCommand: "DownloadedEpisodesScan" | "DownloadedMoviesScan"
  /**
   * History event names as records carry them, mapped to the number the paged
   * history endpoint filters by. It accepts no names.
   */
  eventTypes: Record<string, number>
}

type Signal = AbortSignal | undefined

/** Release searches wait on every indexer; the default 30s is too short. */
const RELEASE_TIMEOUT_MS = 120_000
/**
 * How long one release search answers later reads of the same target. Well
 * under the half hour the Arr keeps the search itself, so a release listed
 * from a kept search can still be grabbed.
 */
export const RELEASE_REUSE_MINUTES = 10
/**
 * A manual-import scan probes every file below the folder. Kept under the
 * time a write has to resolve its target, so the scan's own timeout reports
 * first.
 */
const MANUAL_IMPORT_TIMEOUT_MS = 40_000
/** Grabbing fetches the release from its indexer and hands it to a client. */
const GRAB_TIMEOUT_MS = 60_000
const DEFAULT_RELEASE_LIMIT = 20
const MAX_REJECTION_GROUPS = 8
const PAGE_SIZE = 1000
/** How far a lookup by id walks a list that has no lookup by id. */
const MAX_SCAN_PAGES = 5
const HISTORY_SCAN_PAGE_SIZE = 500
const MAX_HISTORY_SCAN_PAGES = 10
/** A record with its formats is some 650 characters, so 30 fit one result. */
const DEFAULT_HISTORY_PAGE_SIZE = 30
const MAX_NAMES = 30
const MAX_SETTING_CHARS = 300
const MAX_MESSAGE_CHARS = 500
/** A URL with user info, or a query that names a key, token, or password. */
const CREDENTIAL_SHAPED =
  /:\/\/[^/\s]*@|[?&](?:api_?key|token|pass(?:word|wd)?|secret)=/i

export function arrRequest(
  arr: Arr,
  path: string,
  opts: JsonRequestOptions = {},
): Effect.Effect<JsonValue | undefined, JsonRequestError> {
  return jsonRequestEffect<JsonValue | undefined>(arr.cfg.url, path, {
    ...opts,
    headers: { "X-Api-Key": arr.cfg.apiKey },
  })
}

/** One record by path. A 404 is the service saying the id does not exist. */
export function arrObject(
  arr: Arr,
  path: string,
  what: string,
  signal: Signal,
): Effect.Effect<JsonObject, ToolFailure> {
  return arrRequest(arr, path, { signal }).pipe(
    Effect.catchTag(
      "HttpError",
      (error): Effect.Effect<never, ToolFailure> =>
        error.status === 404
          ? toolFail(`${arr.service} has no ${what}`)
          : Effect.fail(error),
    ),
    Effect.flatMap((value) =>
      isJsonObject(value)
        ? Effect.succeed(value)
        : toolFail(`${arr.service} returned no record for ${what}`),
    ),
  )
}

/**
 * A list read is evidence of what exists, so an entry that is no record fails
 * the read. Dropping it would shorten the list, down to an empty one.
 */
export function arrList(
  arr: Arr,
  path: string,
  opts: JsonRequestOptions = {},
): Effect.Effect<JsonObject[], ToolFailure> {
  return arrRequest(arr, path, opts).pipe(
    Effect.flatMap((value) =>
      Array.isArray(value) && value.every(isJsonObject)
        ? Effect.succeed(value)
        : toolFail(
            Array.isArray(value)
              ? `${arr.service} returned a list for ${path} with entries that are not records`
              : `${arr.service} returned no list for ${path}`,
          ),
    ),
  )
}

/**
 * One page of a paged resource (`{ records, totalRecords }`). The total says
 * whether more pages follow, so a page without one is no page.
 */
function arrPage(
  arr: Arr,
  path: string,
  query: NonNullable<JsonRequestOptions["query"]>,
  signal: Signal,
): Effect.Effect<{ records: JsonObject[]; total: number }, ToolFailure> {
  return arrRequest(arr, path, { query, signal }).pipe(
    Effect.flatMap((value) => {
      if (
        !isJsonObject(value) ||
        !Array.isArray(value.records) ||
        !isNumber(value.totalRecords)
      ) {
        return toolFail(`${arr.service} returned no page for ${path}`)
      }
      const records = value.records
      return records.every(isJsonObject)
        ? Effect.succeed({ records, total: value.totalRecords })
        : toolFail(
            `${arr.service} returned a page for ${path} with entries that are not records`,
          )
    }),
  )
}

/**
 * The whole queue, unknown items included. There is no queue read by id and
 * no filter that every Arr version honours, so callers filter this.
 */
export function readQueue(arr: Arr, signal: Signal) {
  return arrPage(
    arr,
    "/api/v3/queue",
    { page: 1, pageSize: PAGE_SIZE, [arr.unknownItemsParam]: true },
    signal,
  )
}

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
function compactHistory(record: JsonObject): JsonObject {
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

function compactBlocklistItem(item: JsonObject): JsonObject {
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

export function compactCommand(command: JsonObject): JsonObject {
  return {
    ...pick(command, [
      "id",
      "name",
      "status",
      "result",
      "message",
      "queued",
      "started",
      "ended",
      "duration",
      "exception",
    ]),
    body: pick(objectField(command, "body"), [
      "seriesId",
      "seasonNumber",
      "episodeIds",
      "movieId",
      "movieIds",
      "path",
      "importMode",
    ]),
  }
}

function compactQualityProfile(
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

/** Where a history read starts: a page, and a record within that page. */
interface HistoryStart {
  page: number
  pageSize: number
  pageOffset: number
}

/**
 * One history page from `pageOffset` on, cut to what a single result holds.
 * `records` is the whole page as the Arr has it. `next` is what reads on from
 * the last record listed: the rest of this page when it was cut, the page
 * after it when one follows. A changed `pageSize` would move the start, so
 * the rest of a cut page is addressed within the same page.
 */
function historyPage(
  start: HistoryStart,
  total: number,
  records: JsonObject[],
): JsonObject {
  const items = records.slice(start.pageOffset).map(compactHistory)
  const withCount = (count: number): JsonObject => {
    const reached = start.pageOffset + count
    const cut = reached < records.length
    const after =
      records.length === start.pageSize && start.page * start.pageSize < total
    return {
      total,
      page: start.page,
      pageSize: start.pageSize,
      ...(start.pageOffset > 0 ? { pageOffset: start.pageOffset } : {}),
      listed: count,
      ...(cut ? { truncated: true } : {}),
      ...(cut
        ? {
            next: {
              page: start.page,
              pageSize: start.pageSize,
              pageOffset: reached,
            },
          }
        : after
          ? { next: { page: start.page + 1, pageSize: start.pageSize } }
          : {}),
      items: items.slice(0, count),
    }
  }
  return withCount(
    fittingCount(items.length, withCount, {
      entry: `the history record at pageOffset ${start.pageOffset} of page ${start.page}`,
    }),
  )
}

/**
 * One named download-client setting, looked up by its exact field name.
 * `null` is a setting this client does not report, which is not a false. A
 * field the Arr marks as a credential is never copied, whatever its name.
 */
function clientSetting(fields: readonly JsonObject[], name: string): JsonValue {
  const field = fields.find((entry) => entry.name === name)
  if (!field) return null
  if (field.privacy !== undefined && field.privacy !== "normal") return null
  const value = field.value
  return isString(value) && CREDENTIAL_SHAPED.test(value)
    ? "[withheld: it looks like it carries a credential]"
    : scalar(value)
}

/** A bounded scalar, or `null` for anything else in its place. */
function scalar(
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

/**
 * What a stall diagnosis needs of one download client: where it is, whether
 * it is used, and which category and directory this Arr hands it. The
 * client's settings list is never passed on.
 */
function compactDownloadClient(arr: Arr, client: JsonObject): JsonObject {
  if (!isString(client.name)) {
    throw new Error(`${arr.service} returned a download client without a name`)
  }
  const fields = client.fields
  // A setting that cannot be read by name would report as one the client
  // does not have.
  if (
    !Array.isArray(fields) ||
    !fields.every(isJsonObject) ||
    !fields.every((field) => isString(field.name))
  ) {
    throw new Error(
      `${arr.service} returned download client ${client.name} without a settings list that can be read`,
    )
  }
  const prefix = arr.clientSettingPrefix
  return {
    ...scalars(client, [
      "id",
      "name",
      "implementation",
      "protocol",
      "enable",
      "priority",
      "removeCompletedDownloads",
      "removeFailedDownloads",
    ]),
    host: clientSetting(fields, "host"),
    port: clientSetting(fields, "port"),
    useSsl: clientSetting(fields, "useSsl"),
    urlBase: clientSetting(fields, "urlBase"),
    category: clientSetting(fields, `${prefix}Category`),
    importedCategory: clientSetting(fields, `${prefix}ImportedCategory`),
    directory: clientSetting(fields, `${prefix}Directory`),
    watchFolder: clientSetting(fields, "watchFolder"),
  }
}

/**
 * A record of a diagnostic list, required to carry the string fields its
 * reading rests on. One without them is no finding, so it fails the read
 * instead of listing as a row of nulls.
 */
function diagnosticRecord(
  arr: Arr,
  what: string,
  record: JsonObject,
  required: readonly string[],
): JsonObject {
  const missing = required.filter((key) => !isString(record[key]))
  if (missing.length > 0) {
    throw new Error(
      `${arr.service} returned a ${what} without a readable ${missing.join(", ")}`,
    )
  }
  return record
}

interface DownloadClientReads {
  clients: JsonObject[]
  mappings: JsonObject[]
  handling: JsonObject
}

/**
 * Clients, path mappings, and handling settings as one result. The two lists
 * share its room: the mappings are offered half of it first, the clients take
 * what that leaves, and the mappings then take what the clients left. Each
 * list says where it was cut.
 */
function downloadClientsResult(
  arr: Arr,
  read: DownloadClientReads,
  offsets: {
    clientOffset?: number | undefined
    mappingOffset?: number | undefined
  },
): JsonObject {
  const clients = read.clients.map((client) =>
    compactDownloadClient(arr, client),
  )
  const mappings = read.mappings.map((mapping) =>
    scalars(
      diagnosticRecord(arr, "remote path mapping", mapping, PATH_MAPPING),
      ["id", ...PATH_MAPPING],
    ),
  )
  const clientOffset = offsets.clientOffset ?? 0
  const mappingOffset = offsets.mappingOffset ?? 0
  const clientPage = clients.slice(clientOffset, clientOffset + MAX_LIST_ITEMS)
  const mappingPage = mappings.slice(
    mappingOffset,
    mappingOffset + MAX_LIST_ITEMS,
  )
  const build = (clientCount: number, mappingCount: number): JsonObject => ({
    clients: listPart(
      clients.length,
      clientOffset,
      clientPage.slice(0, clientCount),
      "nextClientOffset",
    ),
    remotePathMappings: listPart(
      mappings.length,
      mappingOffset,
      mappingPage.slice(0, mappingCount),
      "nextMappingOffset",
    ),
    handling: scalars(read.handling, [
      "enableCompletedDownloadHandling",
      "autoRedownloadFailed",
      "autoRedownloadFailedFromInteractiveSearch",
    ]),
  })
  const chars = (clientCount: number, mappingCount: number) =>
    JSON.stringify(build(clientCount, mappingCount)).length
  const half = (MAX_RESULT_CHARS + chars(0, 0)) / 2
  const offered = largestFitting(
    mappingPage.length,
    (count) => chars(0, count) <= half,
  )
  const clientCount = largestFitting(
    clientPage.length,
    (count) => chars(count, Math.max(offered, 0)) <= MAX_RESULT_CHARS,
  )
  const mappingCount = largestFitting(
    mappingPage.length,
    (count) => chars(Math.max(clientCount, 0), count) <= MAX_RESULT_CHARS,
  )
  // Settings are bounded, so one entry of each list always fits. Should that
  // ever fail, a list that shows nothing must not pass for one that was read.
  if (
    clientCount < Math.min(1, clientPage.length) ||
    mappingCount < Math.min(1, mappingPage.length)
  ) {
    throw new Error(
      `${arr.service} download clients and path mappings do not fit one result of ${MAX_RESULT_CHARS} characters with an entry of each`,
    )
  }
  return build(clientCount, mappingCount)
}

const PATH_MAPPING = ["host", "remotePath", "localPath"] as const

/** One list of a result that holds several, with where to read on from. */
function listPart(
  total: number,
  offset: number,
  items: JsonObject[],
  nextKey: string,
): JsonObject {
  const reached = offset + items.length
  return {
    total,
    listed: items.length,
    ...(offset > 0 ? { offset } : {}),
    ...(reached < total ? { truncated: true, [nextKey]: reached } : {}),
    items,
  }
}

/**
 * A read one diagnostic is built from. Its failure names the part that could
 * not be read, so a partial answer is never taken for the whole one.
 */
function component<A>(
  arr: Arr,
  what: string,
  read: Effect.Effect<A, ToolFailure>,
): Effect.Effect<A, ToolError> {
  return read.pipe(
    Effect.mapError(
      (error) =>
        new ToolError({
          message: `${arr.service} ${what} could not be read, so nothing is reported: ${error.message}`,
        }),
    ),
  )
}

export function sizeText(bytes: JsonValue | undefined): string {
  if (!isNumber(bytes)) return "unknown size"
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
  return `${Math.round(bytes / 1024 ** 2)} MiB`
}

const offsetParam = Type.Optional(
  Type.Integer({
    minimum: 0,
    description: "Skip this many entries when a result came back truncated",
  }),
)

/**
 * Adds the Arr's own item-id param. Its key differs per Arr, so the static
 * type of `params` leaves it out; read it with `itemIdOf`.
 */
function withItemId<P extends TObject>(
  arr: Arr,
  params: P,
  description: string,
): P {
  // SAFETY: only widens the schema by one optional integer.
  return Type.Object({
    ...params.properties,
    [arr.itemKey]: Type.Optional(Type.Integer({ minimum: 1, description })),
  }) as unknown as P
}

function itemIdOf(arr: Arr, params: object): number | undefined {
  // SAFETY: validated arguments are a JSON object.
  const value = (params as JsonObject)[arr.itemKey]
  return isNumber(value) ? value : undefined
}

const historyRead = (arr: Arr) => {
  const eventNames = Object.keys(arr.eventTypes)
  return resource({
    description:
      `History, newest first. With ${arr.itemKey} it is that ${arr.itemNoun}'s whole history. ` +
      "A result carries next while more remains: pass its values with the same filters to read on",
    params: withItemId(
      arr,
      Type.Object({
        eventType: Type.Optional(Type.Enum(eventNames)),
        page: Type.Optional(Type.Integer({ minimum: 1 })),
        pageSize: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 100,
            description: `Default ${DEFAULT_HISTORY_PAGE_SIZE}. A page too long for one result is cut, and next has the rest`,
          }),
        ),
        pageOffset: Type.Optional(
          Type.Integer({
            minimum: 0,
            description:
              "Skip this many records of that page. Only from next, with its page and pageSize",
          }),
        ),
      }),
      `Internal ${arr.service} ${arr.itemNoun} id; omit for every ${arr.itemNoun}`,
    ),
    run: (params, signal) =>
      Effect.gen(function* () {
        const itemId = itemIdOf(arr, params)
        const eventType = params.eventType
        const start: HistoryStart = {
          page: params.page ?? 1,
          pageSize: params.pageSize ?? DEFAULT_HISTORY_PAGE_SIZE,
          pageOffset: params.pageOffset ?? 0,
        }
        if (start.pageOffset >= start.pageSize) {
          return yield* toolFail(
            `pageOffset skips records within one page, so it must be below pageSize ${start.pageSize}`,
          )
        }
        if (itemId !== undefined) {
          const all = yield* arrList(arr, arr.itemHistoryPath, {
            query: { [arr.itemKey]: itemId },
            signal,
          })
          const matching = all.filter(
            (record) =>
              eventType === undefined || record.eventType === eventType,
          )
          const first = (start.page - 1) * start.pageSize
          return yield* toolCheck(() =>
            historyPage(
              start,
              matching.length,
              matching.slice(first, first + start.pageSize),
            ),
          )
        }
        const result = yield* arrPage(
          arr,
          "/api/v3/history",
          {
            page: start.page,
            pageSize: start.pageSize,
            sortKey: "date",
            sortDirection: "descending",
            eventType:
              eventType === undefined ? undefined : arr.eventTypes[eventType],
          },
          signal,
        )
        return yield* toolCheck(() =>
          historyPage(start, result.total, result.records),
        )
      }),
  })
}

/** Reads every blocklist page, newest first, up to the scan bound. */
function readBlocklist(arr: Arr, signal: Signal) {
  return Effect.gen(function* () {
    const records: JsonObject[] = []
    let total = 0
    for (let page = 1; page <= MAX_SCAN_PAGES; page++) {
      const result = yield* arrPage(
        arr,
        "/api/v3/blocklist",
        {
          page,
          pageSize: PAGE_SIZE,
          sortKey: "date",
          sortDirection: "descending",
        },
        signal,
      )
      records.push(...result.records)
      total = result.total
      if (result.records.length < PAGE_SIZE) break
    }
    return { records, total }
  })
}

/** The reads both Arrs serve from the same endpoints. */
export function arrSharedReads(arr: Arr) {
  const itemIdHelp = `Internal ${arr.service} ${arr.itemNoun} id; omit for every ${arr.itemNoun}`
  return {
    queue: resource({
      description: `Download queue. Without ${arr.itemKey} the whole queue, unknown items included`,
      params: withItemId(arr, Type.Object({ offset: offsetParam }), itemIdHelp),
      run: (params, signal) =>
        Effect.gen(function* () {
          const queue = yield* readQueue(arr, signal)
          const wanted = itemIdOf(arr, params)
          const offset = params.offset
          if (wanted === undefined) {
            return listResult(queue.records.map(compactQueueItem), {
              total: queue.total,
              offset,
            })
          }
          return listResult(
            queue.records
              .filter((item) => item[arr.itemKey] === wanted)
              .map(compactQueueItem),
            { offset },
          )
        }),
    }),
    history: historyRead(arr),
    blocklist: resource({
      description: "Blocklisted releases, newest first",
      params: withItemId(arr, Type.Object({ offset: offsetParam }), itemIdHelp),
      run: (params, signal) =>
        Effect.gen(function* () {
          const blocklist = yield* readBlocklist(arr, signal)
          const wanted = itemIdOf(arr, params)
          const offset = params.offset
          if (wanted === undefined) {
            return listResult(blocklist.records.map(compactBlocklistItem), {
              total: blocklist.total,
              offset,
            })
          }
          return {
            ...listResult(
              blocklist.records
                .filter((item) => item[arr.itemKey] === wanted)
                .map(compactBlocklistItem),
              { offset },
            ),
            ...(blocklist.total > blocklist.records.length
              ? {
                  scanned: `newest ${blocklist.records.length} of ${blocklist.total} entries`,
                }
              : {}),
          }
        }),
    }),
    quality_profiles: resource({
      description:
        "List quality profile IDs and names, or pass profileId for one profile's cutoff, allowed qualities, and nonzero custom-format scores",
      params: Type.Object({
        profileId: Type.Optional(Type.Integer({ minimum: 1 })),
        offset: offsetParam,
        formatScoreOffset: Type.Optional(
          Type.Integer({
            minimum: 0,
            description:
              "With profileId only: use nextFormatScoreOffset to read more scores",
          }),
        ),
      }),
      run: (params, signal) =>
        Effect.gen(function* () {
          if (params.profileId !== undefined) {
            if (params.offset !== undefined)
              return yield* toolFail("offset applies to the profile list only")
            const profile = yield* arrObject(
              arr,
              `/api/v3/qualityprofile/${params.profileId}`,
              `quality profile ${params.profileId}`,
              signal,
            )
            return compactQualityProfile(profile, params.formatScoreOffset ?? 0)
          }
          if (params.formatScoreOffset !== undefined)
            return yield* toolFail("formatScoreOffset requires profileId")
          const profiles = yield* arrList(arr, "/api/v3/qualityprofile", {
            signal,
          })
          return listResult(
            profiles.map((profile) => pick(profile, ["id", "name"])),
            { offset: params.offset },
          )
        }),
    }),
    manual_import_candidates: resource({
      description:
        "Files the Arr could import from a folder or download, with its mapping and rejections. " +
        "rejections null is a candidate the Arr sent no rejection list for: unknown, not accepted",
      params: Type.Object(manualImportScope()),
      run: (params, signal) =>
        readCandidates(arr, params, signal).pipe(
          Effect.map((candidates) =>
            listResult(candidates.map(compactCandidate)),
          ),
        ),
    }),
    command_status: resource({
      description: "Status of one command, such as a search or manual import",
      params: Type.Object({ commandId: Type.Integer({ minimum: 1 }) }),
      run: (params, signal) =>
        arrObject(
          arr,
          `/api/v3/command/${params.commandId}`,
          `command ${params.commandId}`,
          signal,
        ).pipe(Effect.map(compactCommand)),
    }),
    health: resource({
      description:
        "The Arr's own health checks, each with its source, level, and message. An empty list is no reported problem, not proof that every dependency works",
      params: Type.Object({}),
      run: (_params, signal) =>
        arrList(arr, "/api/v3/health", { signal }).pipe(
          Effect.flatMap((checks) =>
            toolCheck(() =>
              listResult(
                checks.map((check) => ({
                  ...scalars(
                    diagnosticRecord(arr, "health check", check, [
                      "type",
                      "message",
                    ]),
                    ["source", "type", "wikiUrl"],
                  ),
                  message: scalar(check.message, MAX_MESSAGE_CHARS),
                })),
              ),
            ),
          ),
        ),
    }),
    disk_space: resource({
      description:
        "Free and total bytes of every disk the Arr sees, by the path it sees it at. A null size is one the Arr did not report",
      params: Type.Object({}),
      run: (_params, signal) =>
        arrList(arr, "/api/v3/diskspace", { signal }).pipe(
          Effect.flatMap((disks) =>
            toolCheck(() =>
              listResult(
                disks.map((disk) =>
                  scalars(diagnosticRecord(arr, "disk", disk, ["path"]), [
                    "path",
                    "label",
                    "freeSpace",
                    "totalSpace",
                  ]),
                ),
              ),
            ),
          ),
        ),
    }),
    download_clients: resource({
      description:
        "Download clients with protocol, enabled state, host, and the category and directory this Arr hands them, " +
        "plus remote path mappings and whether completed and failed downloads are handled automatically. No credentials. A null setting is one the client does not report. " +
        "The two lists share one result and each says where it was cut",
      params: Type.Object({
        clientOffset: Type.Optional(
          Type.Integer({
            minimum: 0,
            description: "Skip this many clients; clients.nextClientOffset",
          }),
        ),
        mappingOffset: Type.Optional(
          Type.Integer({
            minimum: 0,
            description:
              "Skip this many mappings; remotePathMappings.nextMappingOffset",
          }),
        ),
      }),
      run: (params, signal) =>
        Effect.gen(function* () {
          const clients = yield* component(
            arr,
            "download clients",
            arrList(arr, "/api/v3/downloadclient", { signal }),
          )
          const mappings = yield* component(
            arr,
            "remote path mappings",
            arrList(arr, "/api/v3/remotepathmapping", { signal }),
          )
          const handling = yield* component(
            arr,
            "download handling settings",
            readDownloadHandling(arr, signal),
          )
          return yield* toolCheck(() =>
            downloadClientsResult(arr, { clients, mappings, handling }, params),
          )
        }),
    }),
  }
}

/** The Arr's settings for what it does with finished and failed downloads. */
function readDownloadHandling(arr: Arr, signal: Signal) {
  return arrObject(
    arr,
    "/api/v3/config/downloadclient",
    "download handling settings",
    signal,
  )
}

export interface ReleaseFilters {
  publishedAfter?: string | undefined
  titleContains?: string | undefined
  approvedOnly?: boolean | undefined
  limit?: number | undefined
}

export interface ReleaseTarget {
  path: string
  /** Whether the Arr mapped this release to the requested item. */
  matches: (release: JsonObject) => boolean
  /** Service-specific mapping fields for one listed release. */
  describe?: (release: JsonObject) => JsonObject
}

export const releaseFilterParams = () => ({
  publishedAfter: Type.Optional(
    Type.String({
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description: "Only releases published on or after this UTC date",
    }),
  ),
  titleContains: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Only releases whose title contains this text",
    }),
  ),
  approvedOnly: Type.Optional(
    Type.Boolean({ description: "Only releases the Arr would grab" }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 50,
      description: `How many releases to list (default ${DEFAULT_RELEASE_LIMIT})`,
    }),
  ),
})

/**
 * Runs one release search and returns counts over every hit plus a filtered,
 * capped listing in the Arr's own preference order. A raw release search
 * returns every indexer hit in full, so the result cap left only the first few
 * candidates, which once read as "no replacement exists". Releases the Arr
 * mapped to another item are only counted: an episode search also returns
 * other episodes' releases, which buried the requested ones.
 *
 * The search asks every indexer, so its raw hits are kept and later reads of
 * the same target are filtered from that copy. Approvals in a kept search are
 * as old as `searchAgeSeconds` says.
 */
export function readReleases(
  arr: Arr,
  target: ReleaseTarget,
  filters: ReleaseFilters,
  signal: Signal,
): Effect.Effect<JsonObject, ToolFailure> {
  return Effect.gen(function* () {
    const search = yield* keptRead(
      `${arr.service} ${target.path}`,
      RELEASE_REUSE_MINUTES * 60_000,
      arrList(arr, target.path, { timeoutMs: RELEASE_TIMEOUT_MS, signal }),
    )
    const releases = search.items
    const forTarget = releases.filter(target.matches)
    const elsewhere = releases.filter((release) => !target.matches(release))
    const matching = forTarget.filter((release) =>
      matchesFilters(release, filters),
    )
    const listed = matching
      .slice(0, filters.limit ?? DEFAULT_RELEASE_LIMIT)
      .map((release) => ({
        ...compactRelease(release),
        ...target.describe?.(release),
      }))
    const summary: JsonObject = {
      searchAgeSeconds: Math.round(search.ageMs / 1000),
      total: releases.length,
      forTarget: forTarget.length,
      approvedForTarget: forTarget.filter(
        (release) => release.approved === true,
      ).length,
      matchingFilters: matching.length,
      rejectionsInMatching: rejectionGroups(matching),
      otherTargets: {
        count: elsewhere.length,
        examples: elsewhere.slice(0, 5).map((release) => release.title ?? null),
      },
    }
    return yield* toolCheck(() => fitListing(summary, listed))
  })
}

/**
 * Drops trailing entries until the result fits one tool result. A cut listing
 * would be invalid JSON and lose the entries' closing fields.
 */
function fitListing(summary: JsonObject, listed: JsonObject[]): JsonObject {
  const withCount = (count: number): JsonObject => ({
    ...summary,
    listed: count,
    releases: listed.slice(0, count),
  })
  return withCount(
    fittingCount(listed.length, withCount, {
      entry: "the first matching release",
    }),
  )
}

function matchesFilters(release: JsonObject, filters: ReleaseFilters): boolean {
  if (filters.approvedOnly === true && release.approved !== true) return false
  if (
    filters.publishedAfter !== undefined &&
    !(
      isString(release.publishDate) &&
      release.publishDate.slice(0, 10) >= filters.publishedAfter
    )
  ) {
    return false
  }
  if (filters.titleContains === undefined) return true
  return (
    isString(release.title) &&
    release.title.toLowerCase().includes(filters.titleContains.toLowerCase())
  )
}

/** `guid` and `indexerId` are what a release is grabbed by. */
function compactRelease(release: JsonObject): JsonObject {
  const rejections = stringList(release.rejections)
  return {
    title: release.title ?? null,
    guid: release.guid ?? null,
    indexerId: release.indexerId ?? null,
    published: isString(release.publishDate)
      ? release.publishDate.slice(0, 10)
      : null,
    indexer: release.indexer ?? null,
    protocol: release.protocol ?? null,
    sizeMb: isNumber(release.size)
      ? Math.round(release.size / 1_000_000)
      : null,
    quality: qualityName(release.quality),
    languages: names(release.languages),
    customFormatScore: release.customFormatScore ?? null,
    customFormats: names(release.customFormats),
    approved: release.approved === true,
    ...(rejections.length > 0 ? { rejections } : {}),
  }
}

function rejectionGroups(releases: JsonObject[]): JsonValue[] {
  const counts = new Map<string, number>()
  for (const reason of releases.flatMap((release) =>
    stringList(release.rejections),
  )) {
    counts.set(reason, (counts.get(reason) ?? 0) + 1)
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_REJECTION_GROUPS)
    .map(([reason, count]) => ({ reason, count }))
}

/** The scope a manual-import scan is read with. */
export const manualImportScope = () => ({
  folder: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Folder as the Arr sees it, e.g. a queue item's outputPath",
    }),
  ),
  downloadId: Type.Optional(
    Type.String({ minLength: 1, description: "A queue item's downloadId" }),
  ),
})

export function readCandidates(
  arr: Arr,
  scope: { folder?: string | undefined; downloadId?: string | undefined },
  signal: Signal,
): Effect.Effect<JsonObject[], ToolFailure> {
  if (scope.folder === undefined && scope.downloadId === undefined) {
    return toolFail("pass folder, downloadId, or both")
  }
  return arrList(arr, "/api/v3/manualimport", {
    query: {
      folder: scope.folder,
      downloadId: scope.downloadId,
      filterExistingFiles: false,
    },
    timeoutMs: MANUAL_IMPORT_TIMEOUT_MS,
    signal,
  })
}

export function compactCandidate(candidate: JsonObject): JsonObject {
  const series = objectField(candidate, "series")
  const movie = objectField(candidate, "movie")
  return {
    ...pick(candidate, [
      "path",
      "folderName",
      "size",
      "quality",
      "languages",
      "releaseGroup",
      "downloadId",
      "seasonNumber",
      "customFormatScore",
    ]),
    ...(series ? { series: pick(series, ["id", "title", "tvdbId"]) } : {}),
    ...(movie ? { movie: pick(movie, ["id", "title", "year", "tmdbId"]) } : {}),
    ...(Array.isArray(candidate.episodes)
      ? {
          episodes: objectList(candidate.episodes).map((episode) =>
            pick(episode, ["id", "seasonNumber", "episodeNumber", "title"]),
          ),
        }
      : {}),
    rejections: rejectionReasons(candidate) ?? null,
  }
}

/**
 * Why the Arr would not import a candidate, or `undefined` when it sent no
 * list of reasons that can be read. An empty list is the only answer that
 * means it rejects nothing.
 */
export function rejectionReasons(candidate: JsonObject): string[] | undefined {
  const rejections = candidate.rejections
  if (!Array.isArray(rejections)) return undefined
  const reasons = rejections.flatMap((rejection) =>
    isJsonObject(rejection) && isString(rejection.reason)
      ? [rejection.reason]
      : [],
  )
  return reasons.length === rejections.length ? reasons : undefined
}

/**
 * Fails an import whose candidates carry no readable rejection list. Those
 * would otherwise go out looking as if the Arr accepted them.
 */
function requireKnownRejections(
  arr: Arr,
  matches: CandidateMatch[],
): Effect.Effect<CandidateMatch[], ToolFailure> {
  const unknown = matches.filter(
    (match) => rejectionReasons(match.candidate) === undefined,
  )
  return unknown.length === 0
    ? Effect.succeed(matches)
    : toolFail(
        `${arr.service} sent no readable rejection list for ${unknown.map((match) => match.path).join(", ")}; whether it rejects them is unknown, so nothing was written`,
      )
}

export interface CandidateMatch {
  path: string
  candidate: JsonObject
}

const MAX_IMPORT_FOLDERS = 3

/** The folder part of a path, whichever separator the Arr's host uses. */
function parentFolder(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "") || path
}

/**
 * Reads the candidates a manual import names and matches each submitted file
 * by path. A path the Arr does not offer fails the import: it would hand the
 * Arr a file it never inspected.
 */
export function matchCandidates(
  arr: Arr,
  scope: { folder?: string | undefined; downloadId?: string | undefined },
  paths: readonly string[],
  signal: Signal,
): Effect.Effect<CandidateMatch[], ToolFailure> {
  return Effect.gen(function* () {
    if (new Set(paths).size !== paths.length) {
      return yield* toolFail("a file path is named twice")
    }
    // Without a scope, each file's own folder is scanned: that scan always
    // lists the file itself.
    const scopes =
      scope.folder !== undefined || scope.downloadId !== undefined
        ? [scope]
        : [...new Set(paths.map(parentFolder))].map((folder) => ({ folder }))
    if (scopes.length > MAX_IMPORT_FOLDERS) {
      return yield* toolFail(
        `the files lie in ${scopes.length} folders; pass folder or downloadId, or import them in smaller calls`,
      )
    }
    const scans = yield* Effect.forEach(
      scopes,
      (entry) => readCandidates(arr, entry, signal),
      { concurrency: MAX_IMPORT_FOLDERS },
    )
    const candidates = scans.flat()
    const missing = paths.filter(
      (path) => !candidates.some((candidate) => candidate.path === path),
    )
    if (missing.length > 0) {
      return yield* toolFail(
        `not among ${arr.service}'s current manual-import candidates: ${missing.join(", ")}`,
      )
    }
    return yield* requireKnownRejections(
      arr,
      paths.flatMap((path) => {
        const candidate = candidates.find((entry) => entry.path === path)
        return candidate ? [{ path, candidate }] : []
      }),
    )
  })
}

/**
 * What a manual import sends for one file besides its target. Taken from the
 * live candidate, so the Arr gets back exactly what it reported.
 */
export function candidateFile(
  match: CandidateMatch,
  downloadId: string | undefined,
): JsonObject {
  return {
    ...pick(match.candidate, [
      "folderName",
      "quality",
      "languages",
      "releaseGroup",
    ]),
    path: match.path,
    downloadId: match.candidate.downloadId ?? downloadId,
  }
}

/**
 * What a downloaded-files scan of `path` would consider. Fails when the Arr
 * sees nothing importable there, which is also how a wrong path shows up.
 */
export function scanCandidates(
  arr: Arr,
  path: string,
  signal: Signal,
): Effect.Effect<CandidateMatch[], ToolFailure> {
  return arrList(arr, "/api/v3/manualimport", {
    query: { folder: path, filterExistingFiles: true },
    timeoutMs: MANUAL_IMPORT_TIMEOUT_MS,
    signal,
  }).pipe(
    Effect.flatMap((candidates) => {
      const matches = candidates.flatMap((candidate) =>
        isString(candidate.path) ? [{ path: candidate.path, candidate }] : [],
      )
      // The scan imports every candidate, so one that cannot be named is one
      // the write could not show.
      if (matches.length < candidates.length) {
        return toolFail(
          `${arr.service} listed ${candidates.length - matches.length} of ${candidates.length} candidates under ${path} without a path, so what the scan would import is unknown; nothing was written`,
        )
      }
      return matches.length > 0
        ? requireKnownRejections(arr, matches)
        : toolFail(`${arr.service} sees no importable file under ${path}`)
    }),
  )
}

export function candidateWarnings(matches: CandidateMatch[]): string[] {
  return matches.flatMap((match) =>
    (rejectionReasons(match.candidate) ?? []).map(
      (reason) => `${match.path}: ${reason}`,
    ),
  )
}

/**
 * The write that scans one folder and imports what the Arr accepts from it.
 * `mapping` says where the Arr would put one candidate.
 */
export function folderScanAction(
  arr: Arr,
  mapping: (candidate: JsonObject) => string,
) {
  return action({
    description:
      `Scan one folder and import every file in it the Arr accepts into the library (${arr.scanCommand}). ` +
      "Accepted files are moved or copied out of the folder as the Arr decides; rejected files stay where they are",
    params: Type.Object({
      path: Type.String({
        minLength: 1,
        description: "Folder to scan and import, as the Arr sees it",
      }),
    }),
    resolve: (params, signal) =>
      scanCandidates(arr, params.path, signal).pipe(
        Effect.map((matches) => ({
          state: null,
          summary: `Scan ${params.path} and import what ${arr.service} accepts: ${matches.length} candidate file(s)`,
          effects: matches.map(
            (match): WriteEffect => ({
              kind: "import",
              target: match.path,
              detail: `mapped to ${mapping(match.candidate)}`,
            }),
          ),
          warnings: candidateWarnings(matches),
        })),
      ),
    write: (params) =>
      postCommand(arr, { name: arr.scanCommand, path: params.path }),
    verify: (_params, result) => verifyCommand(arr, result),
  })
}

export function postCommand(arr: Arr, body: JsonObject) {
  return arrRequest(arr, "/api/v3/command", { method: "POST", body }).pipe(
    Effect.map((command) =>
      isJsonObject(command) ? compactCommand(command) : command,
    ),
  )
}

/**
 * Follow-up read on the queued command so the model sees it was accepted. A
 * response without a usable id is a verification that failed, never a write
 * that did not happen: the Arr answered the command with success.
 */
export function verifyCommand(
  arr: Arr,
  result: JsonValue,
): Effect.Effect<JsonValue, ToolFailure> {
  const id = isJsonObject(result) && isNumber(result.id) ? result.id : undefined
  if (id === undefined) {
    return toolFail(
      `${arr.service} accepted the command, but its answer carried no command id, so its status could not be read back. Do not send it again to get one: read the state it changes`,
    )
  }
  return arrObject(
    arr,
    `/api/v3/command/${id}`,
    `command ${id}`,
    undefined,
  ).pipe(Effect.map(compactCommand))
}

/** HTTP 404 on the record's own path is the proof a delete took effect. */
export function verifyDeleted(
  arr: Arr,
  path: string,
  label: string,
): Effect.Effect<JsonValue, JsonRequestError> {
  return arrRequest(arr, path).pipe(
    Effect.map(
      (): JsonValue => ({ warning: `${label} still present after delete` }),
    ),
    Effect.catchTag("HttpError", (error) =>
      error.status === 404
        ? Effect.succeed({ confirmed: `${label} no longer present (HTTP 404)` })
        : Effect.fail(error),
    ),
  )
}

export interface MonitoringUpdate {
  id: number
  noun: string
  /** External identity that a body without it would reset to 0. */
  identity: "tvdbId" | "tmdbId"
  /** Fields that must read back exactly as they were sent. */
  preserved: readonly string[]
  /** The monitoring fields the read-back must match. */
  monitoring: (record: JsonObject) => JsonObject
}

/**
 * Arr PUT replaces the whole record: an omitted field deserializes to its
 * default (identity 0, no seasons, no path). A record that reads back without
 * its essentials must therefore never be sent back.
 */
export function arrRecord(
  value: JsonObject,
  update: MonitoringUpdate,
): Effect.Effect<JsonObject, ToolFailure> {
  return toolCheck(() => {
    if (value.id !== update.id) {
      throw new Error(
        `${update.noun} ${update.id} did not read back as that record`,
      )
    }
    const identity = value[update.identity]
    if (
      !isNumber(identity) ||
      identity < 1 ||
      !isString(value.path) ||
      value.path === "" ||
      !isNumber(value.qualityProfileId) ||
      typeof value.monitored !== "boolean"
    ) {
      throw new Error(
        `${update.noun} ${update.id} read back without a valid ${update.identity}, path, qualityProfileId, or monitored`,
      )
    }
    return value
  })
}

export function monitoringReadBack(
  record: JsonObject,
  sent: JsonObject,
  update: MonitoringUpdate,
): JsonValue {
  const monitoring = update.monitoring(record)
  const changed = update.preserved.filter(
    (field) => JSON.stringify(record[field]) !== JSON.stringify(sent[field]),
  )
  if (
    changed.length === 0 &&
    JSON.stringify(monitoring) === JSON.stringify(update.monitoring(sent))
  ) {
    return {
      confirmed: "monitoring applied; other fields unchanged",
      monitoring,
    }
  }
  return {
    warning:
      changed.length > 0
        ? `read-back differs in ${changed.join(", ")}`
        : "read-back monitoring differs from the request",
    monitoring,
  }
}

/** Finds one history record. There is no history read by id. */
function findHistoryRecord(
  arr: Arr,
  historyId: number,
  itemId: number | undefined,
  signal: Signal,
): Effect.Effect<JsonObject, ToolFailure> {
  return Effect.gen(function* () {
    if (itemId !== undefined) {
      const records = yield* arrList(arr, arr.itemHistoryPath, {
        query: { [arr.itemKey]: itemId },
        signal,
      })
      const record = records.find((entry) => entry.id === historyId)
      if (record) return record
      return yield* toolFail(
        `${arr.itemNoun} ${itemId} has no history record ${historyId}`,
      )
    }
    for (let page = 1; page <= MAX_HISTORY_SCAN_PAGES; page++) {
      const result = yield* arrPage(
        arr,
        "/api/v3/history",
        {
          page,
          pageSize: HISTORY_SCAN_PAGE_SIZE,
          sortKey: "date",
          sortDirection: "descending",
        },
        signal,
      )
      const record = result.records.find((entry) => entry.id === historyId)
      if (record) return record
      if (result.records.length < HISTORY_SCAN_PAGE_SIZE) {
        return yield* toolFail(
          `${arr.service} has no history record ${historyId}`,
        )
      }
    }
    return yield* toolFail(
      `history record ${historyId} is not among the newest ${MAX_HISTORY_SCAN_PAGES * HISTORY_SCAN_PAGE_SIZE} records; pass ${arr.itemKey} to look it up in that ${arr.itemNoun}'s history`,
    )
  })
}

/**
 * Whether the Arr starts a replacement search itself once a release is marked
 * failed. It reads its own settings for that: redownload must be on, and for
 * a release that was grabbed from an interactive search, on for those too.
 * The record that is marked failed is the one whose release source counts.
 */
function redownloadAfterFailure(
  handling: JsonObject,
  record: JsonObject,
): { searches: boolean | undefined; detail: string } {
  const enabled = handling.autoRedownloadFailed
  if (typeof enabled !== "boolean") {
    return {
      searches: undefined,
      detail:
        "this Arr reported no autoRedownloadFailed setting, so whether it searches a replacement itself is unknown; read the queue afterwards",
    }
  }
  if (!enabled) {
    return {
      searches: false,
      detail:
        "autoRedownloadFailed is off: the Arr starts no replacement search itself",
    }
  }
  if (objectField(record, "data")?.releaseSource !== "InteractiveSearch") {
    return {
      searches: true,
      detail: "started by the Arr itself: autoRedownloadFailed is on",
    }
  }
  const interactive = handling.autoRedownloadFailedFromInteractiveSearch
  if (typeof interactive !== "boolean") {
    return {
      searches: undefined,
      detail:
        "this release came from an interactive search and this Arr reported no autoRedownloadFailedFromInteractiveSearch setting, so whether it searches a replacement itself is unknown; read the queue afterwards",
    }
  }
  return interactive
    ? {
        searches: true,
        detail:
          "started by the Arr itself: autoRedownloadFailed is on, for interactive-search grabs too",
      }
    : {
        searches: false,
        detail:
          "this release came from an interactive search and autoRedownloadFailedFromInteractiveSearch is off: the Arr starts no replacement search itself",
      }
}

/** The writes both Arrs serve from the same endpoints. */
export function arrSharedActions(arr: Arr) {
  return {
    remove_queue_item: action({
      description: "Remove one item from the download queue",
      params: Type.Object({
        queueId: Type.Integer({ minimum: 1 }),
        removeFromClient: Type.Boolean({
          description:
            "true also removes the download and its data from the download client",
        }),
        blocklist: Type.Boolean({
          description: "Blocklist the release so it is not grabbed again",
        }),
      }),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const queue = yield* readQueue(arr, signal)
          if (params.removeFromClient && queue.records.length < queue.total) {
            return yield* toolFail(
              "the queue is truncated; cannot establish every item sharing this download before deleting it",
            )
          }
          const item = queue.records.find(
            (entry) => entry.id === params.queueId,
          )
          if (!item) {
            return yield* toolFail(
              `the ${arr.service} queue has no item ${params.queueId}; it may have finished importing or been removed`,
            )
          }
          const siblings = queue.records.filter(
            (entry) =>
              entry.id !== item.id &&
              isString(item.downloadId) &&
              entry.downloadId === item.downloadId,
          )
          const title = String(item.title ?? "untitled")
          const effect: WriteEffect = {
            kind: "remove",
            target: `queue item ${params.queueId}: ${title}`,
            detail: [
              `downloadId ${String(item.downloadId ?? "none")}`,
              `status ${String(item.status ?? "unknown")}/${String(item.trackedDownloadState ?? "unknown")}`,
              params.removeFromClient
                ? "also removed from the download client with its data"
                : "download and data stay in the download client",
              params.blocklist ? "release blocklisted" : "not blocklisted",
            ].join("; "),
          }
          return {
            state: { item, siblings },
            summary: `Remove queue item ${params.queueId} (${title})${params.removeFromClient ? " and delete its download" : ""}${params.blocklist ? ", blocklisting the release" : ""}`,
            effects: [effect],
            warnings: [
              ...(params.removeFromClient
                ? ["the downloaded data is deleted and cannot be recovered"]
                : []),
              ...(siblings.length > 0
                ? [
                    `${siblings.length} other queue item(s) share this download (ids ${siblings.map((entry) => String(entry.id)).join(", ")}) and lose it too`,
                  ]
                : []),
            ],
          }
        }),
      write: (params) =>
        arrRequest(arr, `/api/v3/queue/${params.queueId}`, {
          method: "DELETE",
          query: {
            removeFromClient: params.removeFromClient,
            blocklist: params.blocklist,
          },
        }),
      verify: (params) =>
        readQueue(arr, undefined).pipe(
          Effect.map((queue): JsonValue => {
            const left = queue.records.find(
              (entry) => entry.id === params.queueId,
            )
            if (!left) {
              if (queue.records.length < queue.total) {
                return {
                  warning: `the queue read is truncated; cannot confirm queue item ${params.queueId} is gone`,
                }
              }
              return { confirmed: `queue item ${params.queueId} is gone` }
            }
            return {
              warning: `queue item ${params.queueId} is still listed; the queue refreshes shortly after a removal, so read it again`,
              item: compactQueueItem(left),
            }
          }),
        ),
    }),
    mark_history_failed: action({
      description:
        "Mark a grabbed release failed, which blocklists it. The result says whether the Arr then searches a replacement itself, from its own redownload settings",
      params: withItemId(
        arr,
        Type.Object({
          historyId: Type.Integer({
            minimum: 1,
            description: `The release's history record, from ${arr.service}_history`,
          }),
        }),
        `The ${arr.itemNoun} the record belongs to. Needed when the record is old`,
      ),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const record = yield* findHistoryRecord(
            arr,
            params.historyId,
            itemIdOf(arr, params),
            signal,
          )
          const queue = yield* readQueue(arr, signal)
          const active = queue.records.filter(
            (entry) =>
              isString(record.downloadId) &&
              entry.downloadId === record.downloadId,
          )
          const title = String(record.sourceTitle ?? "untitled")
          const redownload = redownloadAfterFailure(
            yield* readDownloadHandling(arr, signal),
            record,
          )
          const effect: WriteEffect = {
            kind: "blocklist",
            target: `history record ${params.historyId}: ${title}`,
            detail: `event ${String(record.eventType ?? "unknown")}; downloadId ${String(record.downloadId ?? "none")}`,
          }
          const search: WriteEffect = {
            kind: "search",
            target: `a replacement for ${title}`,
            detail: redownload.detail,
          }
          return {
            state: { record },
            summary: `Mark ${title} failed and blocklist it`,
            effects: redownload.searches === true ? [effect, search] : [effect],
            warnings: [
              ...(redownload.searches === true ? [] : [redownload.detail]),
              ...(active.length > 0
                ? [
                    `this release is still in the queue (${active.map((entry) => `item ${String(entry.id)} ${String(entry.status ?? "")}`).join(", ")}); marking it failed discards that active download`,
                  ]
                : []),
              ...(record.eventType !== "grabbed"
                ? [
                    `record ${params.historyId} is a ${String(record.eventType)} event, not the grab; the Arr fails the grab that shares its downloadId`,
                  ]
                : []),
            ],
          }
        }),
      write: (params) =>
        arrRequest(arr, `/api/v3/history/failed/${params.historyId}`, {
          method: "POST",
        }),
      verify: (_params, _result, state) =>
        arrPage(
          arr,
          "/api/v3/blocklist",
          {
            page: 1,
            pageSize: 100,
            sortKey: "date",
            sortDirection: "descending",
          },
          undefined,
        ).pipe(
          Effect.map((page): JsonValue => {
            const entries = page.records.filter(
              (entry) => entry.sourceTitle === state.record.sourceTitle,
            )
            if (entries.length === 0) {
              return {
                warning:
                  "no blocklist entry with this release title among the newest 100 yet; read the blocklist again",
              }
            }
            return {
              confirmed: "release is blocklisted",
              entries: entries.map(compactBlocklistItem),
            }
          }),
        ),
    }),
    delete_blocklist_entry: action({
      description:
        "Remove one blocklist entry so the release can be grabbed again",
      params: Type.Object({ blocklistId: Type.Integer({ minimum: 1 }) }),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const blocklist = yield* readBlocklist(arr, signal)
          const entry = blocklist.records.find(
            (candidate) => candidate.id === params.blocklistId,
          )
          if (!entry) {
            return yield* toolFail(
              `the ${arr.service} blocklist has no entry ${params.blocklistId}`,
            )
          }
          const title = String(entry.sourceTitle ?? "untitled")
          const effect: WriteEffect = {
            kind: "delete",
            target: `blocklist entry ${params.blocklistId}: ${title}`,
            detail: `blocklisted ${String(entry.date ?? "at an unknown time")}; ${String(entry.message ?? "no message")}`,
          }
          return {
            state: { entry },
            summary: `Remove ${title} from the blocklist`,
            effects: [effect],
            warnings: ["the Arr may grab this release again"],
          }
        }),
      write: (params) =>
        arrRequest(arr, `/api/v3/blocklist/${params.blocklistId}`, {
          method: "DELETE",
        }),
      verify: (params) =>
        readBlocklist(arr, undefined).pipe(
          Effect.map((blocklist): JsonValue => {
            if (
              blocklist.records.some((entry) => entry.id === params.blocklistId)
            ) {
              return {
                warning: `blocklist entry ${params.blocklistId} is still listed`,
              }
            }
            if (blocklist.records.length < blocklist.total) {
              return {
                warning: `the blocklist read is truncated; cannot confirm blocklist entry ${params.blocklistId} is gone`,
              }
            }
            return {
              confirmed: `blocklist entry ${params.blocklistId} is gone`,
            }
          }),
        ),
    }),
    grab_release: action({
      description: `Grab one release listed by ${arr.service}_releases without another indexer search. The Arr only has a release for about 30 minutes after the search that listed it`,
      params: Type.Object({
        guid: Type.String({
          minLength: 1,
          description: `guid of a release from ${arr.service}_releases`,
        }),
        indexerId: Type.Integer({
          minimum: 1,
          description: "indexerId of that same release",
        }),
      }),
      // Only the indexer is resolved. The Arr checks the guid against its own
      // release cache, about 30 minutes after the search, and rejects one it
      // no longer has.
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const indexer = yield* arrObject(
            arr,
            `/api/v3/indexer/${params.indexerId}`,
            `indexer ${params.indexerId}`,
            signal,
          )
          const effect: WriteEffect = {
            kind: "grab",
            target: `release ${params.guid}`,
            detail: `from indexer ${String(indexer.name ?? params.indexerId)}; sent to the download client`,
          }
          return {
            state: null,
            summary: `Grab release ${params.guid} from indexer ${String(indexer.name ?? params.indexerId)}`,
            effects: [effect],
            warnings: ["the release is grabbed even if the Arr rejected it"],
          }
        }),
      write: (params) =>
        arrRequest(arr, "/api/v3/release", {
          method: "POST",
          body: { guid: params.guid, indexerId: params.indexerId },
          timeoutMs: GRAB_TIMEOUT_MS,
        }).pipe(
          Effect.map((release) =>
            isJsonObject(release) ? compactRelease(release) : release,
          ),
        ),
      verify: (_params, result) =>
        readQueue(arr, undefined).pipe(
          Effect.map((queue): JsonValue => {
            const title = isJsonObject(result) ? result.title : undefined
            const queued = queue.records.filter(
              (entry) => isString(title) && entry.title === title,
            )
            if (queued.length === 0) {
              return {
                warning:
                  "the release is not in the queue yet; the queue refreshes shortly after a grab, so read it again",
              }
            }
            return {
              confirmed: "release is queued",
              items: queued.map(compactQueueItem),
            }
          }),
        ),
    }),
  }
}
