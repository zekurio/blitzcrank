import { Effect } from "effect"
import { Type, type Static } from "typebox"

import type { ServiceConfig } from "../config.ts"
import type { JsonValue } from "../http.ts"
import {
  isJsonObject,
  isNumber,
  isString,
  names,
  numberList,
  objectField,
  objectList,
  pick,
  type JsonObject,
} from "../json.ts"
import {
  action,
  defineReads,
  defineWrites,
  listResult,
  resource,
  toolCheck,
  toolFail,
  type ServerTool,
  type ToolFailure,
  type WriteEffect,
} from "../tools.ts"
import {
  arrList,
  arrObject,
  arrRecord,
  arrRequest,
  arrSharedActions,
  arrSharedReads,
  candidateFile,
  candidateWarnings,
  manualImportScope,
  matchCandidates,
  monitoringReadBack,
  postCommand,
  qualityName,
  readReleases,
  RELEASE_REUSE_MINUTES,
  releaseFilterParams,
  scanCandidates,
  sizeText,
  verifyCommand,
  verifyDeleted,
  type Arr,
  type MonitoringUpdate,
  type ReleaseTarget,
} from "./arr-common.ts"

type Signal = AbortSignal | undefined

const seriesIdParam = Type.Integer({
  minimum: 1,
  description: "Internal Sonarr series id (not tvdbId)",
})
const offsetParam = Type.Optional(
  Type.Integer({
    minimum: 0,
    description: "Skip this many entries when a result came back truncated",
  }),
)

export function buildSonarrTools(cfg: ServiceConfig): ServerTool[] {
  const arr: Arr = {
    service: "sonarr",
    cfg,
    itemKey: "seriesId",
    itemNoun: "series",
    unknownItemsParam: "includeUnknownSeriesItems",
    itemHistoryPath: "/api/v3/history/series",
    eventTypes: {
      grabbed: 1,
      seriesFolderImported: 2,
      downloadFolderImported: 3,
      downloadFailed: 4,
      episodeFileDeleted: 5,
      episodeFileRenamed: 6,
      downloadIgnored: 7,
    },
  }
  const service = { name: "sonarr", label: "Sonarr (TV)" }
  return [
    ...defineReads(service, sonarrReads(arr)),
    ...defineWrites(service, sonarrActions(arr)),
  ]
}

function sonarrReads(arr: Arr) {
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
      description: "Episode files of a series with quality and media info",
      params: Type.Object({ seriesId: seriesIdParam, offset: offsetParam }),
      run: (params, signal) =>
        readEpisodeFiles(arr, params.seriesId, signal).pipe(
          Effect.map((files) =>
            listResult(
              files.map((file) => ({
                ...compactEpisodeFile(file),
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
        "Counts cover every hit; the listing is filtered and capped",
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
    raw: shared.raw,
  }
}

function readSeries(arr: Arr, seriesId: number, signal: Signal) {
  return arrObject(
    arr,
    `/api/v3/series/${seriesId}`,
    `series ${seriesId}`,
    signal,
  )
}

function readEpisodes(arr: Arr, seriesId: number, signal: Signal) {
  return arrList(arr, "/api/v3/episode", { query: { seriesId }, signal })
}

function readEpisodeFiles(arr: Arr, seriesId: number, signal: Signal) {
  return arrList(arr, "/api/v3/episodefile", { query: { seriesId }, signal })
}

function compactSeries(series: JsonObject): JsonObject {
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

function compactEpisode(episode: JsonObject): JsonObject {
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

function compactEpisodeFile(file: JsonObject): JsonObject {
  return {
    ...pick(file, ["id", "path", "size", "releaseGroup", "sceneName"]),
    quality: qualityName(file.quality),
    languages: names(file.languages),
    mediaInfo: pick(objectField(file, "mediaInfo"), [
      "audioLanguages",
      "subtitles",
      "videoCodec",
      "audioCodec",
    ]),
  }
}

function episodeLabel(episode: JsonObject): string {
  const pad = (value: JsonValue | undefined) => String(value).padStart(2, "0")
  return `S${pad(episode.seasonNumber)}E${pad(episode.episodeNumber)}`
}

interface ReleaseParams {
  episodeId?: number | undefined
  seriesId?: number | undefined
  seasonNumber?: number | undefined
}

function releaseTarget(params: ReleaseParams): ReleaseTarget {
  if (params.episodeId !== undefined) {
    if (params.seriesId !== undefined || params.seasonNumber !== undefined) {
      throw new Error(
        "pass either episodeId or seriesId with seasonNumber, not both",
      )
    }
    const episodeId = params.episodeId
    return {
      path: `/api/v3/release?episodeId=${episodeId}`,
      matches: (release) => mappedEpisodeIds(release).includes(episodeId),
      describe: describeMappedEpisodes,
    }
  }
  if (params.seriesId === undefined || params.seasonNumber === undefined) {
    throw new Error("pass episodeId, or seriesId with seasonNumber")
  }
  const seriesId = params.seriesId
  const seasonNumber = params.seasonNumber
  return {
    path: `/api/v3/release?seriesId=${seriesId}&seasonNumber=${seasonNumber}`,
    matches: (release) =>
      release.mappedSeriesId === seriesId &&
      release.mappedSeasonNumber === seasonNumber,
    describe: describeMappedEpisodes,
  }
}

function mappedEpisodeIds(release: JsonObject) {
  return objectList(release.mappedEpisodeInfo).flatMap((episode) =>
    isNumber(episode.id) ? [episode.id] : [],
  )
}

/** Scene and absolute numbering is where wrong-episode grabs show up. */
function describeMappedEpisodes(release: JsonObject) {
  const season = release.mappedSeasonNumber
  const episodes = numberList(release.mappedEpisodeNumbers)
  const absolute = numberList(release.mappedAbsoluteEpisodeNumbers)
  return {
    episodes:
      release.fullSeason === true
        ? `S${season} full season`
        : `S${season}E${episodes.join(",")}`,
    ...(absolute.length > 0 ? { absolute } : {}),
  }
}

const searchParams = Type.Object({
  seriesId: seriesIdParam,
  seasonNumber: Type.Optional(
    Type.Integer({ minimum: 0, description: "Search this season only" }),
  ),
  episodeIds: Type.Optional(
    Type.Array(Type.Integer({ minimum: 1 }), {
      minItems: 1,
      maxItems: 100,
      description: "Internal Sonarr episode ids for a targeted search",
    }),
  ),
})

const seriesMonitoringParams = Type.Object({
  seriesId: seriesIdParam,
  monitored: Type.Optional(
    Type.Boolean({ description: "Series-level monitoring" }),
  ),
  seasons: Type.Optional(
    Type.Array(
      Type.Object(
        {
          seasonNumber: Type.Integer({ minimum: 0 }),
          monitored: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      {
        minItems: 1,
        description:
          "Seasons to change; others are kept. A season's flag also sets every episode in it",
      },
    ),
  ),
  monitorNewItems: Type.Optional(
    Type.Enum(["all", "none"], {
      description: "Whether seasons Sonarr adds later are monitored",
    }),
  ),
})

const manualImportFile = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      description:
        "Candidate path, exactly as sonarr_manual_import_candidates has it",
    }),
    seriesId: seriesIdParam,
    episodeIds: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 }),
  },
  { additionalProperties: false },
)

const COMMANDS = [
  "RefreshSeries",
  "RescanSeries",
  "DownloadedEpisodesScan",
  "RefreshMonitoredDownloads",
] as const

const SERIES_PRESERVED = [
  "tvdbId",
  "path",
  "qualityProfileId",
  "languageProfileId",
  "seriesType",
  "seasonFolder",
  "tags",
] as const

type SeasonRecord = JsonObject & { seasonNumber: number; monitored: boolean }

function seriesMonitoringUpdate(seriesId: number): MonitoringUpdate {
  return {
    id: seriesId,
    noun: "series",
    identity: "tvdbId",
    preserved: SERIES_PRESERVED,
    monitoring: (record) => ({
      monitored: record.monitored ?? null,
      monitorNewItems: record.monitorNewItems ?? null,
      seasons: seasonRecords(record).map((season) => ({
        seasonNumber: season.seasonNumber,
        monitored: season.monitored,
      })),
    }),
  }
}

/** Applies the requested monitoring to a copy; throws on an invalid request. */
function patchSeriesMonitoring(
  record: JsonObject,
  params: Static<typeof seriesMonitoringParams>,
): JsonObject {
  if (
    params.monitored === undefined &&
    params.seasons === undefined &&
    params.monitorNewItems === undefined
  ) {
    throw new Error("name monitored, seasons, or monitorNewItems to change")
  }
  const seasons = seasonRecords(record)
  const requested = new Map<number, boolean>()
  for (const season of params.seasons ?? []) {
    if (requested.has(season.seasonNumber)) {
      throw new Error(`season ${season.seasonNumber} is named twice`)
    }
    if (!seasons.some((s) => s.seasonNumber === season.seasonNumber)) {
      throw new Error(
        `series ${params.seriesId} has no season ${season.seasonNumber}`,
      )
    }
    requested.set(season.seasonNumber, season.monitored)
  }
  if (params.monitorNewItems !== undefined && !isString(record.monitorNewItems))
    throw new Error("this Sonarr has no monitorNewItems setting")
  return {
    ...record,
    ...(params.monitored !== undefined ? { monitored: params.monitored } : {}),
    ...(params.monitorNewItems !== undefined
      ? { monitorNewItems: params.monitorNewItems }
      : {}),
    seasons: seasons.map((season) => {
      const monitored = requested.get(season.seasonNumber)
      return monitored === undefined ? season : { ...season, monitored }
    }),
  }
}

/** The PUT sends every season back, so a malformed list must never be sent. */
function seasonRecords(record: JsonObject): SeasonRecord[] {
  const seasons = record.seasons
  if (!Array.isArray(seasons) || !seasons.every(isSeasonRecord)) {
    throw new Error(
      `series ${String(record.id)} read back without a valid seasons list`,
    )
  }
  return seasons
}

function isSeasonRecord(value: JsonValue): value is SeasonRecord {
  return (
    isJsonObject(value) &&
    Number.isInteger(value.seasonNumber) &&
    typeof value.monitored === "boolean"
  )
}

/** The field-level changes a monitoring patch makes, one effect per field. */
function seriesMonitoringEffects(
  seriesId: number,
  before: JsonObject,
  after: JsonObject,
): WriteEffect[] {
  const effects: WriteEffect[] = []
  for (const field of ["monitored", "monitorNewItems"]) {
    if (before[field] !== after[field]) {
      effects.push({
        kind: "update",
        target: `series ${seriesId} ${field}`,
        detail: `${String(before[field])} -> ${String(after[field])}`,
      })
    }
  }
  const previous = new Map(
    seasonRecords(before).map((season) => [
      season.seasonNumber,
      season.monitored,
    ]),
  )
  for (const season of seasonRecords(after)) {
    if (previous.get(season.seasonNumber) !== season.monitored) {
      effects.push({
        kind: "update",
        target: `series ${seriesId} season ${season.seasonNumber} monitored`,
        detail: `${String(previous.get(season.seasonNumber))} -> ${season.monitored}; every episode in the season follows`,
      })
    }
  }
  return effects
}

function searchCommand(
  params: Static<typeof searchParams>,
): JsonObject & { name: string } {
  if (params.episodeIds !== undefined) {
    return { name: "EpisodeSearch", episodeIds: params.episodeIds }
  }
  if (params.seasonNumber !== undefined) {
    return {
      name: "SeasonSearch",
      seriesId: params.seriesId,
      seasonNumber: params.seasonNumber,
    }
  }
  return { name: "SeriesSearch", seriesId: params.seriesId }
}

/** The episodes a search command reaches, resolved against the live series. */
function searchScope(
  arr: Arr,
  params: Static<typeof searchParams>,
  signal: Signal,
): Effect.Effect<{ series: JsonObject; episodes: JsonObject[] }, ToolFailure> {
  return Effect.gen(function* () {
    if (params.episodeIds !== undefined && params.seasonNumber !== undefined) {
      return yield* toolFail("pass seasonNumber or episodeIds, not both")
    }
    const series = yield* readSeries(arr, params.seriesId, signal)
    const all = yield* readEpisodes(arr, params.seriesId, signal)
    if (params.episodeIds !== undefined) {
      const wanted = [...new Set(params.episodeIds)]
      const unknown = wanted.filter(
        (id) => !all.some((episode) => episode.id === id),
      )
      if (unknown.length > 0) {
        return yield* toolFail(
          `series ${params.seriesId} has no episode with id ${unknown.join(", ")}`,
        )
      }
      // An explicit episode search runs for unmonitored episodes too.
      return {
        series,
        episodes: all.filter(
          (episode) => isNumber(episode.id) && wanted.includes(episode.id),
        ),
      }
    }
    const season = params.seasonNumber
    if (
      season !== undefined &&
      !all.some((episode) => episode.seasonNumber === season)
    ) {
      return yield* toolFail(
        `series ${params.seriesId} has no season ${season}`,
      )
    }
    // Series and season searches skip unmonitored episodes.
    return {
      series,
      episodes: all.filter(
        (episode) =>
          episode.monitored === true &&
          (season === undefined || episode.seasonNumber === season),
      ),
    }
  })
}

function unaired(episode: JsonObject, now: number): boolean {
  return !isString(episode.airDateUtc) || Date.parse(episode.airDateUtc) > now
}

function sonarrActions(arr: Arr) {
  const shared = arrSharedActions(arr)
  return {
    auto_search: action({
      description:
        "Search indexers for the whole series, one season, or specific episodes. Sonarr picks and grabs the release",
      params: searchParams,
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const scope = yield* searchScope(arr, params, signal)
          const command = searchCommand(params)
          const title = String(
            scope.series.title ?? `series ${params.seriesId}`,
          )
          if (scope.episodes.length === 0) {
            return yield* toolFail(
              `${command.name} would search nothing: no monitored episode in scope for ${title}`,
            )
          }
          const withFiles = scope.episodes.filter(
            (episode) => episode.hasFile === true,
          )
          const notAired = scope.episodes.filter((episode) =>
            unaired(episode, Date.now()),
          )
          const unmonitored = scope.episodes.filter(
            (episode) => episode.monitored !== true,
          )
          const target =
            params.episodeIds !== undefined
              ? `${title}: ${scope.episodes.map(episodeLabel).join(", ")}`
              : params.seasonNumber !== undefined
                ? `${title} season ${params.seasonNumber}`
                : `${title}, every season`
          const counts = `${scope.episodes.length} episode(s), ${withFiles.length} with files`
          const effect: WriteEffect = {
            kind: "search",
            target,
            detail: counts,
          }
          return {
            state: null,
            summary: `${command.name} for ${target}: ${counts}${withFiles.length > 0 ? " that a grab may replace" : ""}`,
            effects: [effect],
            warnings: [
              ...(notAired.length > 0
                ? [`${notAired.length} episode(s) in scope have not aired`]
                : []),
              ...(unmonitored.length > 0
                ? [
                    `${unmonitored.length} named episode(s) are unmonitored and are searched anyway`,
                  ]
                : []),
              ...(scope.series.monitored !== true
                ? ["the series itself is unmonitored"]
                : []),
              ...(params.episodeIds === undefined &&
              params.seasonNumber === undefined
                ? ["this searches the whole series"]
                : []),
            ],
          }
        }),
      write: (params) => postCommand(arr, searchCommand(params)),
      verify: (_params, result) => verifyCommand(arr, result),
    }),
    set_series_monitoring: action({
      description:
        "Change a series' monitored flag, named seasons, or monitorNewItems. Every other series field is kept",
      params: seriesMonitoringParams,
      lock: (params) => `series:${params.seriesId}`,
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const update = seriesMonitoringUpdate(params.seriesId)
          const record = yield* arrRecord(
            yield* readSeries(arr, params.seriesId, signal),
            update,
          )
          const effects = yield* toolCheck(() =>
            seriesMonitoringEffects(
              params.seriesId,
              record,
              patchSeriesMonitoring(record, params),
            ),
          )
          if (effects.length === 0) {
            return yield* toolFail(
              `series ${params.seriesId} already has that monitoring; there is nothing to change`,
            )
          }
          return {
            state: { record },
            summary: `Change monitoring of ${String(record.title ?? `series ${params.seriesId}`)}: ${effects.length} field(s)`,
            effects,
            warnings: effects.some((effect) => effect.target.includes("season"))
              ? [
                  "a season's flag overrides the per-episode monitoring inside it",
                ]
              : [],
          }
        }),
      write: (params, state) =>
        Effect.gen(function* () {
          const body = yield* toolCheck(() =>
            patchSeriesMonitoring(state.record, params),
          )
          const written = yield* arrRequest(
            arr,
            `/api/v3/series/${params.seriesId}`,
            { method: "PUT", body },
          )
          return isJsonObject(written) ? compactSeries(written) : written
        }),
      verify: (params, _result, state) =>
        Effect.gen(function* () {
          const update = seriesMonitoringUpdate(params.seriesId)
          const after = yield* arrRecord(
            yield* readSeries(arr, params.seriesId, undefined),
            update,
          )
          return yield* toolCheck(() =>
            monitoringReadBack(
              after,
              patchSeriesMonitoring(state.record, params),
              update,
            ),
          )
        }),
    }),
    set_episode_monitoring: action({
      description: "Set the monitored flag of specific episodes",
      params: Type.Object({
        episodeIds: Type.Array(Type.Integer({ minimum: 1 }), {
          minItems: 1,
          maxItems: 100,
          description: "Internal Sonarr episode ids",
        }),
        monitored: Type.Boolean(),
      }),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const episodes = yield* readEpisodesById(
            arr,
            params.episodeIds,
            signal,
          )
          const changing = episodes.filter(
            (episode) => episode.monitored !== params.monitored,
          )
          if (changing.length === 0) {
            return yield* toolFail(
              `every named episode already has monitored=${params.monitored}; there is nothing to change`,
            )
          }
          return {
            state: null,
            summary: `Set monitored=${params.monitored} on ${changing.length} episode(s)`,
            effects: changing.map(
              (episode): WriteEffect => ({
                kind: "update",
                target: `episode ${String(episode.id)} (${episodeLabel(episode)}) monitored`,
                detail: `${String(episode.monitored)} -> ${params.monitored}`,
              }),
            ),
            warnings:
              changing.length < episodes.length
                ? [
                    `${episodes.length - changing.length} named episode(s) already have monitored=${params.monitored}`,
                  ]
                : [],
          }
        }),
      write: (params) =>
        arrRequest(arr, "/api/v3/episode/monitor", {
          method: "PUT",
          body: { episodeIds: params.episodeIds, monitored: params.monitored },
        }).pipe(
          Effect.map((): JsonValue => ({ updated: params.episodeIds.length })),
        ),
      verify: (params) =>
        readEpisodesById(arr, params.episodeIds, undefined).pipe(
          Effect.map((episodes): JsonValue => {
            const flags = episodes.map((episode) => ({
              id: episode.id ?? null,
              monitored: episode.monitored ?? null,
            }))
            return episodes.every(
              (episode) => episode.monitored === params.monitored,
            )
              ? { confirmed: "episode monitoring applied", episodes: flags }
              : {
                  warning: "read-back monitoring differs from the request",
                  episodes: flags,
                }
          }),
        ),
    }),
    delete_episode_file: action({
      description:
        "Delete one episode file from disk so a replacement can be searched",
      params: Type.Object({ episodeFileId: Type.Integer({ minimum: 1 }) }),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const file = yield* arrObject(
            arr,
            `/api/v3/episodefile/${params.episodeFileId}`,
            `episode file ${params.episodeFileId}`,
            signal,
          )
          const episodes = yield* arrList(arr, "/api/v3/episode", {
            query: { episodeFileId: params.episodeFileId },
            signal,
          })
          const covered =
            episodes.length > 0
              ? episodes.map(episodeLabel).join(", ")
              : "no episode"
          const path = String(
            file.path ?? `episode file ${params.episodeFileId}`,
          )
          const effect: WriteEffect = {
            kind: "delete",
            target: path,
            detail: `${sizeText(file.size)}; covers ${covered}`,
          }
          return {
            state: null,
            summary: `Delete episode file ${params.episodeFileId} (${path}, ${sizeText(file.size)}), covering ${covered}`,
            effects: [effect],
            warnings: [
              "the file is removed from disk",
              ...(episodes.length > 1
                ? [`this one file holds ${episodes.length} episodes`]
                : []),
            ],
          }
        }),
      write: (params) =>
        arrRequest(arr, `/api/v3/episodefile/${params.episodeFileId}`, {
          method: "DELETE",
        }).pipe(
          Effect.map(
            (): JsonValue => ({
              deleted: `episode file ${params.episodeFileId}`,
            }),
          ),
        ),
      verify: (params) =>
        verifyDeleted(
          arr,
          `/api/v3/episodefile/${params.episodeFileId}`,
          "episode file",
        ),
    }),
    remove_queue_item: shared.remove_queue_item,
    mark_history_failed: shared.mark_history_failed,
    delete_blocklist_entry: shared.delete_blocklist_entry,
    grab_release: shared.grab_release,
    manual_import: action({
      description:
        "Import files Sonarr offers as manual-import candidates into named episodes. " +
        "Quality, languages, and release group come from the live candidate",
      params: Type.Object({
        files: Type.Array(manualImportFile, { minItems: 1, maxItems: 50 }),
        importMode: Type.Enum(["auto", "move", "copy"], {
          description: "move for a finished download",
        }),
        ...manualImportScope(),
      }),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const matches = yield* matchCandidates(
            arr,
            params,
            params.files.map((file) => file.path),
            signal,
          )
          const seriesIds = [
            ...new Set(params.files.map((file) => file.seriesId)),
          ]
          const targets = new Map(
            yield* Effect.forEach(seriesIds, (seriesId) =>
              Effect.gen(function* () {
                const series = yield* readSeries(arr, seriesId, signal)
                const episodes = yield* readEpisodes(arr, seriesId, signal)
                return [seriesId, { series, episodes }] as const
              }),
            ),
          )
          const effects: WriteEffect[] = []
          for (const file of params.files) {
            const target = targets.get(file.seriesId)
            const match = matches.find((entry) => entry.path === file.path)
            const episodes = (target?.episodes ?? []).filter(
              (episode) =>
                isNumber(episode.id) && file.episodeIds.includes(episode.id),
            )
            if (episodes.length !== new Set(file.episodeIds).size) {
              return yield* toolFail(
                `series ${file.seriesId} does not have every episode id named for ${file.path}`,
              )
            }
            effects.push({
              kind: "import",
              target: file.path,
              detail: `${params.importMode} into ${String(target?.series.title ?? `series ${file.seriesId}`)} ${episodes.map(episodeLabel).join(", ")} as ${String(qualityName(match?.candidate.quality) ?? "unknown quality")}`,
            })
          }
          return {
            state: { matches },
            summary: `Manual import of ${params.files.length} file(s), mode ${params.importMode}`,
            effects,
            warnings: candidateWarnings(matches),
          }
        }),
      write: (params, state) =>
        postCommand(arr, {
          name: "ManualImport",
          importMode: params.importMode,
          files: state.matches.flatMap((match) => {
            const file = params.files.find((entry) => entry.path === match.path)
            if (!file) return []
            return [
              {
                ...candidateFile(match, params.downloadId),
                seriesId: file.seriesId,
                episodeIds: file.episodeIds,
              },
            ]
          }),
        }),
      verify: (_params, result) => verifyCommand(arr, result),
    }),
    run_command: action({
      description:
        "Make Sonarr re-read disk or downloader state: RefreshSeries and RescanSeries need seriesId, " +
        "DownloadedEpisodesScan needs path",
      params: Type.Object({
        name: Type.Enum(COMMANDS),
        seriesId: Type.Optional(seriesIdParam),
        path: Type.Optional(
          Type.String({
            minLength: 1,
            description: "Folder to scan and import, as Sonarr sees it",
          }),
        ),
      }),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          if (params.name === "RefreshMonitoredDownloads") {
            return {
              state: null,
              summary:
                "Re-check every monitored download in the download clients",
              effects: [
                {
                  kind: "command",
                  target: "download clients",
                  detail: "RefreshMonitoredDownloads",
                },
              ],
              warnings: [],
            }
          }
          if (params.name === "DownloadedEpisodesScan") {
            if (params.path === undefined) {
              return yield* toolFail("DownloadedEpisodesScan needs path")
            }
            const matches = yield* scanCandidates(arr, params.path, signal)
            return {
              state: null,
              summary: `Scan ${params.path} and import what Sonarr accepts: ${matches.length} candidate file(s)`,
              effects: matches.map(
                (match): WriteEffect => ({
                  kind: "import",
                  target: match.path,
                  detail: `mapped to ${String(objectField(match.candidate, "series")?.title ?? "no series")} ${objectList(match.candidate.episodes).map(episodeLabel).join(", ") || "no episode"}`,
                }),
              ),
              warnings: candidateWarnings(matches),
            }
          }
          if (params.seriesId === undefined) {
            return yield* toolFail(`${params.name} needs seriesId`)
          }
          const series = yield* readSeries(arr, params.seriesId, signal)
          return {
            state: null,
            summary: `${params.name} for ${String(series.title ?? `series ${params.seriesId}`)}`,
            effects: [
              {
                kind: "command",
                target: `series ${params.seriesId}: ${String(series.title ?? "")}`,
                detail: `${params.name} over ${String(series.path ?? "its folder")}`,
              },
            ],
            warnings: [],
          }
        }),
      write: (params) =>
        postCommand(arr, {
          name: params.name,
          ...(params.name === "DownloadedEpisodesScan"
            ? { path: params.path }
            : {}),
          ...(params.name === "RefreshSeries" || params.name === "RescanSeries"
            ? { seriesId: params.seriesId }
            : {}),
        }),
      verify: (_params, result) => verifyCommand(arr, result),
    }),
  }
}

/** One read per id: a list read answers a missing id with HTTP 500. */
function readEpisodesById(
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
