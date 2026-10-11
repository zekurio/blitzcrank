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
  listResult,
  MAX_RESULT_CHARS,
  rawPath,
  rawResult,
  resource,
  toolCheck,
  toolFail,
  toText,
  type PlanEffect,
  type ToolFailure,
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
   * History event names as records carry them, mapped to the number the paged
   * history endpoint filters by. It accepts no names.
   */
  eventTypes: Record<string, number>
}

type Signal = AbortSignal | undefined

/** Release searches wait on every indexer; the default 30s is too short. */
const RELEASE_TIMEOUT_MS = 120_000
/**
 * A manual-import scan probes every file below the folder. Kept under the
 * time an apply has for its re-read, so the scan's own timeout reports first.
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

export function arrList(
  arr: Arr,
  path: string,
  opts: JsonRequestOptions = {},
): Effect.Effect<JsonObject[], ToolFailure> {
  return arrRequest(arr, path, opts).pipe(
    Effect.flatMap((value) =>
      Array.isArray(value)
        ? Effect.succeed(value.filter(isJsonObject))
        : toolFail(`${arr.service} returned no list for ${path}`),
    ),
  )
}

/** One page of a paged resource (`{ records, totalRecords }`). */
function arrPage(
  arr: Arr,
  path: string,
  query: NonNullable<JsonRequestOptions["query"]>,
  signal: Signal,
): Effect.Effect<{ records: JsonObject[]; total: number }, ToolFailure> {
  return arrRequest(arr, path, { query, signal }).pipe(
    Effect.flatMap((value) => {
      if (!isJsonObject(value) || !Array.isArray(value.records)) {
        return toolFail(`${arr.service} returned no page for ${path}`)
      }
      const records = value.records.filter(isJsonObject)
      return Effect.succeed({
        records,
        total: isNumber(value.totalRecords)
          ? value.totalRecords
          : records.length,
      })
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

function compactQualityProfile(profile: JsonObject): JsonObject {
  const items = objectList(profile.items)
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
    formatScores: objectList(profile.formatItems)
      .filter((item) => isNumber(item.score) && item.score !== 0)
      .slice(0, 60)
      .map((item) => ({ name: item.name ?? null, score: item.score ?? null })),
  }
}

/** `quality` is a `{ quality: { name }, revision }` model on every record. */
export function qualityName(value: JsonValue | undefined): JsonValue {
  const model = isJsonObject(value) ? value : undefined
  return objectField(model, "quality")?.name ?? null
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
    description: `History, newest first. With ${arr.itemKey} it is that ${arr.itemNoun}'s whole history`,
    params: withItemId(
      arr,
      Type.Object({
        eventType: Type.Optional(Type.Enum(eventNames)),
        page: Type.Optional(Type.Integer({ minimum: 1 })),
        pageSize: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 100, description: "Default 50" }),
        ),
      }),
      `Internal ${arr.service} ${arr.itemNoun} id; omit for every ${arr.itemNoun}`,
    ),
    run: (params, signal) =>
      Effect.gen(function* () {
        const itemId = itemIdOf(arr, params)
        const eventType = params.eventType
        const page = params.page ?? 1
        const pageSize = params.pageSize ?? 50
        if (itemId !== undefined) {
          const all = yield* arrList(arr, arr.itemHistoryPath, {
            query: { [arr.itemKey]: itemId },
            signal,
          })
          const matching = all.filter(
            (record) =>
              eventType === undefined || record.eventType === eventType,
          )
          const start = (page - 1) * pageSize
          const items = matching.slice(start, start + pageSize)
          return {
            total: matching.length,
            page,
            pageSize,
            listed: items.length,
            items: items.map(compactHistory),
          }
        }
        const result = yield* arrPage(
          arr,
          "/api/v3/history",
          {
            page,
            pageSize,
            sortKey: "date",
            sortDirection: "descending",
            eventType:
              eventType === undefined ? undefined : arr.eventTypes[eventType],
          },
          signal,
        )
        return {
          total: result.total,
          page,
          pageSize,
          listed: result.records.length,
          items: result.records.map(compactHistory),
        }
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
    qualityProfiles: resource({
      description: "Quality profiles with cutoff and custom-format scores",
      params: Type.Object({}),
      run: (_params, signal) =>
        arrList(arr, "/api/v3/qualityprofile", { signal }).pipe(
          Effect.map((profiles) =>
            listResult(profiles.map(compactQualityProfile)),
          ),
        ),
    }),
    manualImportCandidates: resource({
      description:
        "Files the Arr could import from a folder or download, with its mapping and rejections",
      params: Type.Object(manualImportScope()),
      run: (params, signal) =>
        readCandidates(arr, params, signal).pipe(
          Effect.map((candidates) =>
            listResult(candidates.map(compactCandidate)),
          ),
        ),
    }),
    command: resource({
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
    raw: resource({
      description:
        "Any other GET below /api/v3. Uncompacted; prefer a named resource",
      params: Type.Object({
        path: Type.String({
          description:
            "Service-relative path with its query string, e.g. /api/v3/languageprofile",
        }),
      }),
      run: (params, signal) =>
        Effect.gen(function* () {
          const path = yield* rawPath(params.path, "/api/v3")
          const response = yield* arrRequest(arr, path, {
            signal,
            jsonOnly: true,
          })
          return rawResult(response, [arr.cfg.apiKey])
        }),
    }),
  }
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
 */
export function readReleases(
  arr: Arr,
  target: ReleaseTarget,
  filters: ReleaseFilters,
  signal: Signal,
): Effect.Effect<JsonObject, ToolFailure> {
  return Effect.gen(function* () {
    const releases = yield* arrList(arr, target.path, {
      timeoutMs: RELEASE_TIMEOUT_MS,
      signal,
    })
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
    return fitListing(
      {
        total: releases.length,
        forTarget: forTarget.length,
        approvedForTarget: forTarget.filter(
          (release) => release.approved === true,
        ).length,
        matchingFilters: matching.length,
        rejectionsInMatching: rejectionGroups(matching),
        otherTargets: {
          count: elsewhere.length,
          examples: elsewhere
            .slice(0, 5)
            .map((release) => release.title ?? null),
        },
      },
      listed,
    )
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
  const fits = listed
    .map((_, index) => listed.length - index)
    .find((count) => toText(withCount(count)).length <= MAX_RESULT_CHARS)
  return withCount(fits ?? 0)
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

/** `guid` and `indexerId` are what `POST /api/v3/release` grabs by. */
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

/**
 * `quality` and `languages` stay whole: a manual import sends them back
 * exactly as read.
 */
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
    rejections: rejectionReasons(candidate),
  }
}

export function rejectionReasons(candidate: JsonObject): string[] {
  return objectList(candidate.rejections).flatMap((rejection) =>
    isString(rejection.reason) ? [rejection.reason] : [],
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
 * Re-reads the candidates a manual import names and matches each submitted
 * file by path. A path the Arr does not offer fails the plan: importing it
 * would hand the Arr a file it never inspected.
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
        `the files lie in ${scopes.length} folders; pass folder or downloadId, or import them in smaller plans`,
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
    return paths.flatMap((path) => {
      const candidate = candidates.find((entry) => entry.path === path)
      return candidate ? [{ path, candidate }] : []
    })
  })
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
      return matches.length > 0
        ? Effect.succeed(matches)
        : toolFail(`${arr.service} sees no importable file under ${path}`)
    }),
  )
}

/** The candidate set a manual import was planned over. */
export function candidateFingerprint(matches: CandidateMatch[]): JsonValue {
  return matches
    .map((match) => ({
      path: match.path,
      size: match.candidate.size ?? null,
      rejections: rejectionReasons(match.candidate),
      target: importTargetFingerprint(match.candidate),
      quality: match.candidate.quality ?? null,
      languages: match.candidate.languages ?? null,
      releaseGroup: match.candidate.releaseGroup ?? null,
      downloadId: match.candidate.downloadId ?? null,
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

/** Both an automatic mapping and an explicit import depend on its destination. */
export function importTargetFingerprint(target: JsonObject): JsonValue {
  return {
    series: pick(objectField(target, "series"), ["id", "title", "path"]),
    movie: pick(objectField(target, "movie"), [
      "id",
      "title",
      "path",
      "hasFile",
      "movieFileId",
    ]),
    episodes: objectList(target.episodes)
      .map((episode) => ({
        id: isNumber(episode.id) ? episode.id : 0,
        ...pick(episode, [
          "seriesId",
          "seasonNumber",
          "episodeNumber",
          "hasFile",
          "episodeFileId",
        ]),
      }))
      .sort((a, b) => a.id - b.id),
  }
}

export function candidateWarnings(matches: CandidateMatch[]): string[] {
  return matches.flatMap((match) =>
    rejectionReasons(match.candidate).map(
      (reason) => `${match.path}: ${reason}`,
    ),
  )
}

export function postCommand(arr: Arr, body: JsonObject) {
  return arrRequest(arr, "/api/v3/command", { method: "POST", body }).pipe(
    Effect.map((command) =>
      isJsonObject(command) ? compactCommand(command) : command,
    ),
  )
}

/** Follow-up read on the queued command so the model sees it was accepted. */
export function verifyCommand(
  arr: Arr,
  result: JsonValue,
): Effect.Effect<JsonValue, ToolFailure> {
  const id = isJsonObject(result) && isNumber(result.id) ? result.id : undefined
  if (id === undefined) {
    return Effect.succeed({
      warning: "the command response had no id; read the command list via raw",
    })
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

/** The state a monitoring plan depends on: what it changes and what it keeps. */
export function monitoringFingerprint(
  record: JsonObject,
  update: MonitoringUpdate,
): JsonValue {
  return {
    ...update.monitoring(record),
    ...Object.fromEntries(
      update.preserved.map((field) => [field, record[field] ?? null]),
    ),
  }
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

/** The writes both Arrs serve from the same endpoints. */
export function arrSharedActions(arr: Arr) {
  return {
    removeQueueItem: action({
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
      plan: (params, signal) =>
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
          const effect: PlanEffect = {
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
      fingerprint: (state) => ({
        item: pick(state.item, [
          "id",
          "downloadId",
          "title",
          "status",
          "trackedDownloadStatus",
          "trackedDownloadState",
          "outputPath",
          "seriesId",
          "episodeId",
          "movieId",
        ]),
        siblings: state.siblings
          .map((item) => ({
            id: isNumber(item.id) ? item.id : 0,
            ...pick(item, ["seriesId", "episodeId", "movieId"]),
          }))
          .sort((a, b) => a.id - b.id),
      }),
      apply: (params) =>
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
              return { confirmed: `queue item ${params.queueId} is gone` }
            }
            return {
              warning: `queue item ${params.queueId} is still listed; the queue refreshes shortly after a removal, so read it again`,
              item: compactQueueItem(left),
            }
          }),
        ),
    }),
    markHistoryFailed: action({
      description:
        "Mark a grabbed release failed, which blocklists it and lets the Arr search a replacement",
      params: withItemId(
        arr,
        Type.Object({
          historyId: Type.Integer({
            minimum: 1,
            description: "The release's history record, from a history read",
          }),
        }),
        `The ${arr.itemNoun} the record belongs to. Needed when the record is old`,
      ),
      plan: (params, signal) =>
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
          const effect: PlanEffect = {
            kind: "blocklist",
            target: `history record ${params.historyId}: ${title}`,
            detail: `event ${String(record.eventType ?? "unknown")}; downloadId ${String(record.downloadId ?? "none")}`,
          }
          return {
            state: { record, active: active.length > 0 },
            summary: `Mark ${title} failed and blocklist it`,
            effects: [effect],
            warnings: [
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
              "with automatic redownload on (the default) the Arr searches a replacement itself",
            ],
          }
        }),
      fingerprint: (state) => ({
        historyId: state.record.id ?? null,
        eventType: state.record.eventType ?? null,
        sourceTitle: state.record.sourceTitle ?? null,
        downloadId: state.record.downloadId ?? null,
        inQueue: state.active,
      }),
      apply: (params) =>
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
    deleteBlocklistEntry: action({
      description:
        "Remove one blocklist entry so the release can be grabbed again",
      params: Type.Object({ blocklistId: Type.Integer({ minimum: 1 }) }),
      plan: (params, signal) =>
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
          const effect: PlanEffect = {
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
      fingerprint: (state) => ({
        blocklistId: state.entry.id ?? null,
        sourceTitle: state.entry.sourceTitle ?? null,
      }),
      apply: (params) =>
        arrRequest(arr, `/api/v3/blocklist/${params.blocklistId}`, {
          method: "DELETE",
        }),
      verify: (params) =>
        readBlocklist(arr, undefined).pipe(
          Effect.map(
            (blocklist): JsonValue =>
              blocklist.records.some((entry) => entry.id === params.blocklistId)
                ? {
                    warning: `blocklist entry ${params.blocklistId} is still listed`,
                  }
                : {
                    confirmed: `blocklist entry ${params.blocklistId} is gone`,
                  },
          ),
        ),
    }),
    grabRelease: action({
      description:
        "Grab one specific release from a fresh releases read, bypassing the Arr's own choice",
      params: Type.Object({
        guid: Type.String({
          minLength: 1,
          description: "guid of a release from a releases read",
        }),
        indexerId: Type.Integer({
          minimum: 1,
          description: "indexerId of that same release",
        }),
      }),
      plan: (params, signal) =>
        Effect.gen(function* () {
          const indexer = yield* arrObject(
            arr,
            `/api/v3/indexer/${params.indexerId}`,
            `indexer ${params.indexerId}`,
            signal,
          )
          const effect: PlanEffect = {
            kind: "grab",
            target: `release ${params.guid}`,
            detail: `from indexer ${String(indexer.name ?? params.indexerId)}; sent to the download client`,
          }
          return {
            state: { indexer: indexer.name ?? null },
            summary: `Grab release ${params.guid} from indexer ${String(indexer.name ?? params.indexerId)}`,
            effects: [effect],
            warnings: [
              `${arr.service} only grabs a release still in its search cache, about 30 minutes after the releases read; an unknown guid fails at apply`,
              "the release is grabbed even if the Arr rejected it",
            ],
          }
        }),
      // The Arr resolves the guid against its own release cache at apply.
      fingerprint: undefined,
      apply: (params) =>
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
