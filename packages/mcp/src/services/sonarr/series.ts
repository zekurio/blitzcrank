import { Effect } from "effect"
import { Type } from "typebox"

import type { JsonValue, Signal } from "../../http.ts"
import {
  names,
  objectField,
  objectList,
  pick,
  type JsonObject,
} from "../../json.ts"
import type { ToolFailure } from "../../tools/errors.ts"
import { arrList, arrObject, type Arr } from "../arr/client.ts"
import { qualityName, scalars } from "../arr/compact.ts"

export const SERIES_ID_HELP = "Internal Sonarr series id (not tvdbId)"
export const seriesIdParam = Type.Integer({
  minimum: 1,
  description: SERIES_ID_HELP,
})

export function readSeries(arr: Arr, seriesId: number, signal: Signal) {
  return arrObject(
    arr,
    `/api/v3/series/${seriesId}`,
    `series ${seriesId}`,
    signal,
  )
}

/** A series' episodes, or one season's; callers still match the season. */
export function readEpisodes(
  arr: Arr,
  seriesId: number,
  signal: Signal,
  seasonNumber?: number,
) {
  return arrList(arr, "/api/v3/episode", {
    query: { seriesId, seasonNumber },
    signal,
  })
}

export function readEpisodeFiles(arr: Arr, seriesId: number, signal: Signal) {
  return arrList(arr, "/api/v3/episodefile", { query: { seriesId }, signal })
}

export function compactSeries(series: JsonObject): JsonObject {
  return {
    ...pick(series, [
      "id",
      "title",
      "year",
      "status",
      "monitored",
      "monitorNewItems",
      "path",
      "qualityProfileId",
      "seriesType",
      "tvdbId",
      "tmdbId",
      "imdbId",
      "nextAiring",
      "previousAiring",
      "tags",
    ]),
    statistics: seriesStatistics(objectField(series, "statistics")),
    seasons: objectList(series.seasons).map((season) => ({
      ...pick(season, ["seasonNumber", "monitored"]),
      statistics: seriesStatistics(objectField(season, "statistics")),
    })),
  }
}

function seriesStatistics(statistics: JsonObject | undefined): JsonObject {
  return pick(statistics, [
    "episodeFileCount",
    "episodeCount",
    "totalEpisodeCount",
    "sizeOnDisk",
  ])
}

export function compactEpisode(episode: JsonObject): JsonObject {
  return pick(episode, [
    "id",
    "seasonNumber",
    "episodeNumber",
    "absoluteEpisodeNumber",
    "title",
    "airDate",
    "airDateUtc",
    "monitored",
    "hasFile",
    "episodeFileId",
  ])
}

export function compactEpisodeFile(file: JsonObject): JsonObject {
  return {
    ...pick(file, ["id", "path", "size", "releaseGroup", "sceneName"]),
    quality: qualityName(file.quality),
    ...scalars(file, ["customFormatScore", "qualityCutoffNotMet"]),
    languages: names(file.languages),
    mediaInfo: pick(objectField(file, "mediaInfo"), [
      "audioLanguages",
      "subtitles",
      "videoCodec",
      "audioCodec",
    ]),
  }
}

export function episodeLabel(episode: JsonObject): string {
  const pad = (value: JsonValue | undefined) => String(value).padStart(2, "0")
  return `S${pad(episode.seasonNumber)}E${pad(episode.episodeNumber)}`
}

/**
 * Episodes by id in one list read. It answers a missing id with HTTP 500,
 * which names no id, so it suits ids known to exist. A Sonarr that ignores
 * the filter answers with more, so callers match the ids again.
 */
export function readEpisodeList(
  arr: Arr,
  episodeIds: readonly number[],
  signal: Signal,
) {
  const query = [...new Set(episodeIds)].map((id) => `episodeIds=${id}`)
  return arrList(arr, `/api/v3/episode?${query.join("&")}`, { signal })
}

/** One read per id, so a missing one is named. */
export function readEpisodesById(
  arr: Arr,
  episodeIds: readonly number[],
  signal: Signal,
): Effect.Effect<JsonObject[], ToolFailure> {
  return Effect.forEach(
    [...new Set(episodeIds)],
    (id) => arrObject(arr, `/api/v3/episode/${id}`, `episode ${id}`, signal),
    { concurrency: 4 },
  )
}
