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
import { toolFail, type ToolFailure } from "../../tools/errors.ts"

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

/** Reads every blocklist page, newest first, up to the scan bound. */
export function readBlocklist(arr: Arr, signal: Signal) {
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

/** The Arr's settings for what it does with finished and failed downloads. */
export function readDownloadHandling(arr: Arr, signal: Signal) {
  return arrObject(
    arr,
    "/api/v3/config/downloadclient",
    "download handling settings",
    signal,
  )
}
