import { Effect } from "effect"
import { Type } from "typebox"

import { isNumber, objectField, objectList, pick } from "../../json.ts"
import { toolCheck, toolFail } from "../../tools/errors.ts"
import { resource } from "../../tools/reads.ts"
import { listResult } from "../../tools/results.ts"
import { arrList, type Arr } from "../arr/client.ts"
import { namesOrNull } from "../arr/compact.ts"
import { offsetParam } from "../arr/params.ts"
import { arrSharedReads } from "../arr/reads.ts"
import {
  readReleases,
  RELEASE_REUSE_MINUTES,
  releaseFilterParams,
} from "../arr/releases.ts"
import { releaseTarget } from "./releases.ts"
import {
  compactEpisode,
  compactEpisodeFile,
  compactSeries,
  readEpisodeFiles,
  readEpisodes,
  readSeries,
  seriesIdParam,
} from "./series.ts"

export function sonarrReads(arr: Arr) {
  const shared = arrSharedReads(arr)
  return {
    series: resource({
      description:
        "One tracked series with seasons and statistics. Pass tvdbId or seriesId",
      params: Type.Object({
        tvdbId: Type.Optional(
          Type.Integer({ minimum: 1, description: "TVDB id, as Seerr has it" }),
        ),
        seriesId: Type.Optional(seriesIdParam),
      }),
      run: (params, signal) =>
        Effect.gen(function* () {
          if ((params.tvdbId === undefined) === (params.seriesId === undefined))
            return yield* toolFail("pass exactly one of tvdbId or seriesId")
          if (params.seriesId !== undefined) {
            return compactSeries(
              yield* readSeries(arr, params.seriesId, signal),
            )
          }
          const tracked = yield* arrList(arr, "/api/v3/series", {
            query: { tvdbId: params.tvdbId },
            signal,
          })
          // Older Sonarr ignores the filter and returns every series.
          const series = tracked.find((entry) => entry.tvdbId === params.tvdbId)
          if (!series) {
            return yield* toolFail(
              `sonarr tracks no series with tvdbId ${params.tvdbId}`,
            )
          }
          return compactSeries(series)
        }),
    }),
    lookup: resource({
      description:
        "Metadata lookup by title or tvdb:ID. A hit does not prove the series is tracked",
      params: Type.Object({ term: Type.String({ minLength: 1 }) }),
      run: (params, signal) =>
        arrList(arr, "/api/v3/series/lookup", {
          query: { term: params.term },
          signal,
        }).pipe(
          Effect.map((results) =>
            listResult(
              results.map((series) => ({
                ...pick(series, [
                  "title",
                  "year",
                  "tvdbId",
                  "tmdbId",
                  "imdbId",
                  "status",
                  "seriesType",
                  "network",
                  "firstAired",
                ]),
                seasonCount: objectList(series.seasons).length,
                // A lookup hit carries an id only when Sonarr tracks it.
                ...(isNumber(series.id) && series.id > 0
                  ? { trackedSeriesId: series.id }
                  : {}),
              })),
            ),
          ),
        ),
    }),
    episodes: resource({
      description: "Episodes of a series, each with its file summary",
      params: Type.Object({
        seriesId: seriesIdParam,
        seasonNumber: Type.Optional(Type.Integer({ minimum: 0 })),
        offset: offsetParam,
      }),
      run: (params, signal) =>
        Effect.gen(function* () {
          const series = yield* readSeries(arr, params.seriesId, signal)
          const episodes = yield* readEpisodes(arr, params.seriesId, signal)
          const files = yield* readEpisodeFiles(arr, params.seriesId, signal)
          const fileById = new Map(files.map((file) => [file.id, file]))
          const inScope = episodes.filter(
            (episode) =>
              params.seasonNumber === undefined ||
              episode.seasonNumber === params.seasonNumber,
          )
          return {
            series: pick(series, ["id", "title", "seriesType", "monitored"]),
            ...listResult(
              inScope.map((episode) => {
                const file = fileById.get(episode.episodeFileId)
                return {
                  ...compactEpisode(episode),
                  ...(file ? { file: compactEpisodeFile(file) } : {}),
                }
              }),
              { offset: params.offset },
            ),
          }
        }),
    }),
    episode_files: resource({
      description:
        "Episode files of a series with quality, custom formats and score, cutoff status, and media info",
      params: Type.Object({ seriesId: seriesIdParam, offset: offsetParam }),
      run: (params, signal) =>
        readEpisodeFiles(arr, params.seriesId, signal).pipe(
          Effect.map((files) =>
            listResult(
              files.map((file) => ({
                ...compactEpisodeFile(file),
                customFormats: namesOrNull(file.customFormats),
                seasonNumber: file.seasonNumber ?? null,
              })),
              { offset: params.offset },
            ),
          ),
        ),
    }),
    queue: shared.queue,
    history: shared.history,
    blocklist: shared.blocklist,
    quality_profiles: shared.quality_profiles,
    calendar: resource({
      description: "Episodes airing in a date window, unmonitored included",
      params: Type.Object({
        start: Type.String({ description: "ISO date or date-time" }),
        end: Type.String({ description: "ISO date or date-time" }),
      }),
      run: (params, signal) =>
        arrList(arr, "/api/v3/calendar", {
          query: {
            start: params.start,
            end: params.end,
            includeSeries: true,
            unmonitored: true,
          },
          signal,
        }).pipe(
          Effect.map((episodes) =>
            listResult(
              episodes.map((episode) => ({
                ...compactEpisode(episode),
                seriesId: episode.seriesId ?? null,
                seriesTitle: objectField(episode, "series")?.title ?? null,
                tvdbId: objectField(episode, "series")?.tvdbId ?? null,
              })),
            ),
          ),
        ),
    }),
    releases: resource({
      description:
        "Indexer search for one episode (episodeId) or one season (seriesId with seasonNumber). Grabs nothing. " +
        `One search answers every read of the same target for ${RELEASE_REUSE_MINUTES} minutes, whatever the filters; searchAgeSeconds is its age. ` +
        "Counts cover every hit; the listing is filtered and capped. " +
        "With no release for the target it also reads Sonarr's health on every call: warnings name each indexer problem, or say health could not be read, and then the list proves nothing about what was published",
      params: Type.Object({
        episodeId: Type.Optional(
          Type.Integer({
            minimum: 1,
            description: "Internal Sonarr episode id",
          }),
        ),
        seriesId: Type.Optional(seriesIdParam),
        seasonNumber: Type.Optional(Type.Integer({ minimum: 0 })),
        ...releaseFilterParams(),
      }),
      run: (params, signal) =>
        Effect.gen(function* () {
          const target = yield* toolCheck(() => releaseTarget(params))
          return yield* readReleases(arr, target, params, signal)
        }),
    }),
    manual_import_candidates: shared.manual_import_candidates,
    command_status: shared.command_status,
    health: shared.health,
    disk_space: shared.disk_space,
    download_clients: shared.download_clients,
  }
}
