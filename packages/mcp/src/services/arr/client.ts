import { Effect } from "effect"

import type { ServiceConfig } from "../../config.ts"
import {
  jsonRequestEffect,
  type JsonRequestError,
  type JsonRequestOptions,
  type JsonValue,
  type Signal,
} from "../../http.ts"
import { isJsonObject, isNumber, type JsonObject } from "../../json.ts"
import {
  requireRecord,
  toolFail,
  type ToolFailure,
} from "../../tools/errors.ts"

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
   * history endpoint filters by. It accepts no names; the per-item endpoint
   * takes the names.
   */
  eventTypes: Record<string, number>
}

const PAGE_SIZE = 1000
/** How far a lookup by id walks a list that has no lookup by id. */
const MAX_SCAN_PAGES = 5

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

export function arrObject(
  arr: Arr,
  path: string,
  what: string,
  signal: Signal,
): Effect.Effect<JsonObject, ToolFailure> {
  return requireRecord(arr.service, what, arrRequest(arr, path, { signal }))
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
export function arrPage(
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
 * The queue, unknown items included, or one item's part of it. There is no
 * queue read by id. An Arr that ignores the item filter answers with the
 * whole queue, so callers match the item themselves.
 */
export function readQueue(arr: Arr, signal: Signal, itemId?: number) {
  return arrPage(
    arr,
    "/api/v3/queue",
    {
      page: 1,
      pageSize: PAGE_SIZE,
      [arr.unknownItemsParam]: true,
      [`${arr.itemKey}s`]: itemId,
    },
    signal,
  )
}

/** How many blocklist entries a lookup by id walks; there is no read by id. */
export const BLOCKLIST_SCAN = MAX_SCAN_PAGES * PAGE_SIZE

/**
 * Blocklist entries newest first, up to `limit` or else the scan bound. With
 * `itemId` only that item's, which callers still match, as for the queue.
 * Paging stops after a page holding an entry `until` accepts.
 */
export function readBlocklist(
  arr: Arr,
  signal: Signal,
  opts: {
    limit?: number
    itemId?: number
    until?: (entry: JsonObject) => boolean
  } = {},
) {
  const limit = opts.limit ?? BLOCKLIST_SCAN
  const pageSize = Math.min(limit, PAGE_SIZE)
  const until = opts.until ?? (() => false)
  return Effect.gen(function* () {
    const records: JsonObject[] = []
    let total = 0
    for (let page = 1; records.length < limit; page++) {
      const result = yield* arrPage(
        arr,
        "/api/v3/blocklist",
        {
          page,
          pageSize,
          sortKey: "date",
          sortDirection: "descending",
          [`${arr.itemKey}s`]: opts.itemId,
        },
        signal,
      )
      records.push(...result.records)
      total = result.total
      if (result.records.length < pageSize || result.records.some(until)) break
    }
    return { records, total }
  })
}

/** The Arr's settings for what it does with finished and failed downloads. */
export function readDownloadHandling(arr: Arr, signal: Signal) {
  return arrObject(
    arr,
    "/api/v3/config/downloadclient",
    "download handling settings",
    signal,
  )
}
