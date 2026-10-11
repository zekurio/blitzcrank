import { Effect } from "effect"
import { Type } from "typebox"

import type { ServiceConfig } from "../config.ts"
import type { JsonValue } from "../http.ts"
import {
  isJsonObject,
  isNumber,
  names,
  objectField,
  pick,
  type JsonObject,
} from "../json.ts"
import type { PlanStore } from "../plans.ts"
import {
  action,
  defineRead,
  definePlanApply,
  listResult,
  resource,
  toolFail,
  type PlanEffect,
  type ServerTool,
} from "../tools.ts"
import {
  arrList,
  arrObject,
  arrRecord,
  arrRequest,
  arrSharedActions,
  arrSharedReads,
  candidateFingerprint,
  candidateWarnings,
  importTargetFingerprint,
  manualImportScope,
  matchCandidates,
  monitoringFingerprint,
  monitoringReadBack,
  postCommand,
  qualityName,
  readReleases,
  releaseFilterParams,
  scanCandidates,
  sizeText,
  verifyCommand,
  verifyDeleted,
  type Arr,
  type MonitoringUpdate,
} from "./arr-common.ts"

type Signal = AbortSignal | undefined

const movieIdParam = Type.Integer({
  minimum: 1,
  description: "Internal Radarr movie id (not tmdbId)",
})

export function buildRadarrTools(
  cfg: ServiceConfig,
  plans: PlanStore,
): ServerTool[] {
  const arr: Arr = {
    service: "radarr",
    cfg,
    itemKey: "movieId",
    itemNoun: "movie",
    unknownItemsParam: "includeUnknownMovieItems",
    itemHistoryPath: "/api/v3/history/movie",
    eventTypes: {
      grabbed: 1,
      downloadFolderImported: 3,
      downloadFailed: 4,
      movieFileDeleted: 6,
      movieFolderImported: 7,
      movieFileRenamed: 8,
      downloadIgnored: 9,
    },
  }
  return [
    defineRead(
      "radarr",
      "Read Radarr state for movies: tracking, files, queue, history, and release candidates.",
      radarrReads(arr),
    ),
    ...definePlanApply("radarr", radarrActions(arr), plans),
  ]
}

function radarrReads(arr: Arr) {
  const shared = arrSharedReads(arr)
  return {
    movie: resource({
      description:
        "One tracked movie with its file summary. Pass tmdbId or movieId",
      params: Type.Object({
        tmdbId: Type.Optional(
          Type.Integer({ minimum: 1, description: "TMDB id, as Seerr has it" }),
        ),
        movieId: Type.Optional(movieIdParam),
      }),
      run: (params, signal) =>
        Effect.gen(function* () {
          if ((params.tmdbId === undefined) === (params.movieId === undefined))
            return yield* toolFail("pass exactly one of tmdbId or movieId")
          if (params.movieId !== undefined) {
            return compactMovie(yield* readMovie(arr, params.movieId, signal))
          }
          const tracked = yield* arrList(arr, "/api/v3/movie", {
            query: { tmdbId: params.tmdbId },
            signal,
          })
          const movie = tracked.find((entry) => entry.tmdbId === params.tmdbId)
          if (!movie) {
            return yield* toolFail(
              `radarr tracks no movie with tmdbId ${params.tmdbId}`,
            )
          }
          return compactMovie(movie)
        }),
    }),
    lookup: resource({
      description:
        "Metadata lookup by title or tmdb:ID. A hit does not prove the movie is tracked",
      params: Type.Object({ term: Type.String({ minLength: 1 }) }),
      run: (params, signal) =>
        arrList(arr, "/api/v3/movie/lookup", {
          query: { term: params.term },
          signal,
        }).pipe(
          Effect.map((results) =>
            listResult(
              results.map((movie) => ({
                ...pick(movie, [
                  "title",
                  "year",
                  "tmdbId",
                  "imdbId",
                  "status",
                  "inCinemas",
                  "digitalRelease",
                  "physicalRelease",
                ]),
                // A lookup hit carries an id only when Radarr tracks it.
                ...(isNumber(movie.id) && movie.id > 0
                  ? { trackedMovieId: movie.id }
                  : {}),
              })),
            ),
          ),
        ),
    }),
    movieFiles: resource({
      description: "Files of one movie with quality and media info",
      params: Type.Object({ movieId: movieIdParam }),
      run: (params, signal) =>
        arrList(arr, "/api/v3/moviefile", {
          query: { movieId: params.movieId },
          signal,
        }).pipe(Effect.map((files) => listResult(files.map(compactMovieFile)))),
    }),
    queue: shared.queue,
    history: shared.history,
    blocklist: shared.blocklist,
    qualityProfiles: shared.qualityProfiles,
    calendar: resource({
      description:
        "Movies with a cinema, digital, or physical release in a date window",
      params: Type.Object({
        start: Type.String({ description: "ISO date or date-time" }),
        end: Type.String({ description: "ISO date or date-time" }),
      }),
      run: (params, signal) =>
        arrList(arr, "/api/v3/calendar", {
          query: { start: params.start, end: params.end, unmonitored: true },
          signal,
        }).pipe(
          Effect.map((movies) =>
            listResult(
              movies.map((movie) =>
                pick(movie, [
                  "id",
                  "title",
                  "year",
                  "tmdbId",
                  "status",
                  "monitored",
                  "hasFile",
                  "isAvailable",
                  "inCinemas",
                  "digitalRelease",
                  "physicalRelease",
                ]),
              ),
            ),
          ),
        ),
    }),
    releases: resource({
      description:
        "Live indexer search for one movie. Grabs nothing. Counts cover every hit; the listing is filtered and capped",
      params: Type.Object({ movieId: movieIdParam, ...releaseFilterParams() }),
      run: (params, signal) =>
        readReleases(
          arr,
          {
            path: `/api/v3/release?movieId=${params.movieId}`,
            matches: (release) => release.mappedMovieId === params.movieId,
          },
          params,
          signal,
        ),
    }),
    manualImportCandidates: shared.manualImportCandidates,
    command: shared.command,
    raw: shared.raw,
  }
}

function readMovie(arr: Arr, movieId: number, signal: Signal) {
  return arrObject(arr, `/api/v3/movie/${movieId}`, `movie ${movieId}`, signal)
}

function compactMovie(movie: JsonObject): JsonObject {
  const file = objectField(movie, "movieFile")
  return {
    ...pick(movie, [
      "id",
      "title",
      "year",
      "status",
      "monitored",
      "hasFile",
      "isAvailable",
      "minimumAvailability",
      "path",
      "qualityProfileId",
      "tmdbId",
      "imdbId",
      "inCinemas",
      "digitalRelease",
      "physicalRelease",
      "sizeOnDisk",
      "tags",
    ]),
    ...(file ? { movieFile: compactMovieFile(file) } : {}),
  }
}

function compactMovieFile(file: JsonObject): JsonObject {
  return {
    ...pick(file, [
      "id",
      "movieId",
      "path",
      "size",
      "releaseGroup",
      "sceneName",
      "edition",
    ]),
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

function movieLabel(movie: JsonObject): string {
  return `${String(movie.title ?? `movie ${String(movie.id)}`)} (${String(movie.year ?? "unknown year")})`
}

const manualImportFile = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      description: "Candidate path, exactly as manualImportCandidates has it",
    }),
    folderName: Type.Optional(Type.String()),
    movieId: movieIdParam,
    quality: Type.Record(Type.String(), Type.Unknown(), {
      description: "The candidate's quality object, unchanged",
    }),
    languages: Type.Array(Type.Record(Type.String(), Type.Unknown()), {
      description: "The candidate's languages, unchanged",
    }),
    releaseGroup: Type.Optional(Type.String()),
    downloadId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
)

const COMMANDS = [
  "RefreshMovie",
  "RescanMovie",
  "DownloadedMoviesScan",
  "RefreshMonitoredDownloads",
] as const

function movieMonitoringUpdate(movieId: number): MonitoringUpdate {
  return {
    id: movieId,
    noun: "movie",
    identity: "tmdbId",
    preserved: [
      "tmdbId",
      "path",
      "qualityProfileId",
      "minimumAvailability",
      "tags",
    ],
    monitoring: (record) => ({ monitored: record.monitored ?? null }),
  }
}

function radarrActions(arr: Arr) {
  const shared = arrSharedActions(arr)
  return {
    search: action({
      description:
        "Search indexers for one movie. Radarr picks and grabs the release",
      params: Type.Object({ movieId: movieIdParam }),
      plan: (params, signal) =>
        Effect.gen(function* () {
          const movie = yield* readMovie(arr, params.movieId, signal)
          const label = movieLabel(movie)
          const effect: PlanEffect = {
            kind: "search",
            target: `movie ${params.movieId}: ${label}`,
            detail:
              movie.hasFile === true
                ? "has a file that a grab may replace"
                : "has no file",
          }
          return {
            state: { movie },
            summary: `MoviesSearch for ${label}${movie.hasFile === true ? ", whose file a grab may replace" : ""}`,
            effects: [effect],
            warnings: [
              ...(movie.monitored !== true
                ? ["the movie is unmonitored and is searched anyway"]
                : []),
              ...(movie.isAvailable === false
                ? [
                    `Radarr does not consider the movie available yet (minimumAvailability ${String(movie.minimumAvailability)})`,
                  ]
                : []),
            ],
          }
        }),
      fingerprint: (state) => ({
        movieId: state.movie.id ?? null,
        monitored: state.movie.monitored ?? null,
        hasFile: state.movie.hasFile ?? null,
        movieFileId: state.movie.movieFileId ?? null,
        isAvailable: state.movie.isAvailable ?? null,
      }),
      apply: (params) =>
        postCommand(arr, { name: "MoviesSearch", movieIds: [params.movieId] }),
      verify: (_params, result) => verifyCommand(arr, result),
    }),
    setMovieMonitoring: action({
      description:
        "Change whether Radarr monitors a movie. Every other movie field is kept",
      params: Type.Object({ movieId: movieIdParam, monitored: Type.Boolean() }),
      plan: (params, signal) =>
        Effect.gen(function* () {
          const record = yield* arrRecord(
            yield* readMovie(arr, params.movieId, signal),
            movieMonitoringUpdate(params.movieId),
          )
          if (record.monitored === params.monitored) {
            return yield* toolFail(
              `movie ${params.movieId} already has monitored=${params.monitored}; there is nothing to change`,
            )
          }
          const effect: PlanEffect = {
            kind: "update",
            target: `movie ${params.movieId} monitored`,
            detail: `${String(record.monitored)} -> ${params.monitored}`,
          }
          return {
            state: { record },
            summary: `Set monitored=${params.monitored} on ${movieLabel(record)}`,
            effects: [effect],
            warnings: [],
          }
        }),
      fingerprint: (state, params) =>
        monitoringFingerprint(
          state.record,
          movieMonitoringUpdate(params.movieId),
        ),
      apply: (params, state) =>
        arrRequest(arr, `/api/v3/movie/${params.movieId}`, {
          method: "PUT",
          body: { ...state.record, monitored: params.monitored },
        }).pipe(
          Effect.map((written) =>
            isJsonObject(written) ? compactMovie(written) : written,
          ),
        ),
      verify: (params, _result, state) =>
        Effect.gen(function* () {
          const update = movieMonitoringUpdate(params.movieId)
          const after = yield* arrRecord(
            yield* readMovie(arr, params.movieId, undefined),
            update,
          )
          return monitoringReadBack(
            after,
            { ...state.record, monitored: params.monitored },
            update,
          )
        }),
    }),
    deleteMovieFile: action({
      description:
        "Delete one movie file from disk so a replacement can be searched",
      params: Type.Object({ movieFileId: Type.Integer({ minimum: 1 }) }),
      plan: (params, signal) =>
        Effect.gen(function* () {
          const file = yield* arrObject(
            arr,
            `/api/v3/moviefile/${params.movieFileId}`,
            `movie file ${params.movieFileId}`,
            signal,
          )
          const movie = isNumber(file.movieId)
            ? yield* readMovie(arr, file.movieId, signal)
            : undefined
          const label = movie ? movieLabel(movie) : "an unknown movie"
          const path = String(file.path ?? `movie file ${params.movieFileId}`)
          const effect: PlanEffect = {
            kind: "delete",
            target: path,
            detail: `${sizeText(file.size)}; the file of ${label}`,
          }
          return {
            state: { file },
            summary: `Delete movie file ${params.movieFileId} (${path}, ${sizeText(file.size)}) of ${label}`,
            effects: [effect],
            warnings: ["this removes the movie's only copy from disk"],
          }
        }),
      fingerprint: (state) => ({
        movieFileId: state.file.id ?? null,
        movieId: state.file.movieId ?? null,
        path: state.file.path ?? null,
        size: state.file.size ?? null,
      }),
      apply: (params) =>
        arrRequest(arr, `/api/v3/moviefile/${params.movieFileId}`, {
          method: "DELETE",
        }).pipe(
          Effect.map(
            (): JsonValue => ({ deleted: `movie file ${params.movieFileId}` }),
          ),
        ),
      verify: (params) =>
        verifyDeleted(
          arr,
          `/api/v3/moviefile/${params.movieFileId}`,
          "movie file",
        ),
    }),
    removeQueueItem: shared.removeQueueItem,
    markHistoryFailed: shared.markHistoryFailed,
    deleteBlocklistEntry: shared.deleteBlocklistEntry,
    grabRelease: shared.grabRelease,
    manualImport: action({
      description:
        "Import files Radarr offers as manual-import candidates into named movies",
      params: Type.Object({
        files: Type.Array(manualImportFile, { minItems: 1, maxItems: 50 }),
        importMode: Type.Enum(["auto", "move", "copy"], {
          description: "auto follows the download client's setting",
        }),
        ...manualImportScope(),
      }),
      plan: (params, signal) =>
        Effect.gen(function* () {
          const matches = yield* matchCandidates(
            arr,
            params,
            params.files.map((file) => file.path),
            signal,
          )
          const movieIds = [
            ...new Set(params.files.map((file) => file.movieId)),
          ]
          const movies = new Map(
            yield* Effect.forEach(movieIds, (movieId) =>
              readMovie(arr, movieId, signal).pipe(
                Effect.map((movie) => [movieId, movie] as const),
              ),
            ),
          )
          const effects = params.files.map((file): PlanEffect => {
            const movie = movies.get(file.movieId)
            return {
              kind: "import",
              target: file.path,
              detail: `${params.importMode} into ${movie ? movieLabel(movie) : `movie ${file.movieId}`} as ${String(qualityName(file.quality as JsonValue) ?? "unknown quality")}`,
            }
          })
          return {
            state: {
              matches,
              targets: params.files.map((file) => ({
                movie: movies.get(file.movieId) ?? null,
              })),
            },
            summary: `Manual import of ${params.files.length} file(s), mode ${params.importMode}`,
            effects,
            warnings: candidateWarnings(matches),
          }
        }),
      fingerprint: (state) => ({
        candidates: candidateFingerprint(state.matches),
        targets: state.targets.map(importTargetFingerprint),
      }),
      apply: (params) =>
        postCommand(arr, {
          name: "ManualImport",
          importMode: params.importMode,
          files: params.files.map((file) => ({
            path: file.path,
            folderName: file.folderName,
            movieId: file.movieId,
            // SAFETY: both arrived as JSON and passed the file schema.
            quality: file.quality as JsonValue,
            languages: file.languages as JsonValue,
            releaseGroup: file.releaseGroup,
            downloadId: file.downloadId ?? params.downloadId,
          })),
        }),
      verify: (_params, result) => verifyCommand(arr, result),
    }),
    command: action({
      description:
        "Make Radarr re-read disk or downloader state: RefreshMovie and RescanMovie need movieId, " +
        "DownloadedMoviesScan needs path",
      params: Type.Object({
        name: Type.Enum(COMMANDS),
        movieId: Type.Optional(movieIdParam),
        path: Type.Optional(
          Type.String({
            minLength: 1,
            description: "Folder to scan and import, as Radarr sees it",
          }),
        ),
      }),
      plan: (params, signal) =>
        Effect.gen(function* () {
          if (params.name === "RefreshMonitoredDownloads") {
            const effect: PlanEffect = {
              kind: "command",
              target: "download clients",
              detail: "RefreshMonitoredDownloads",
            }
            return {
              state: { target: null as JsonValue },
              summary:
                "Re-check every monitored download in the download clients",
              effects: [effect],
              warnings: [],
            }
          }
          if (params.name === "DownloadedMoviesScan") {
            if (params.path === undefined) {
              return yield* toolFail("DownloadedMoviesScan needs path")
            }
            const matches = yield* scanCandidates(arr, params.path, signal)
            return {
              state: { target: candidateFingerprint(matches) },
              summary: `Scan ${params.path} and import what Radarr accepts: ${matches.length} candidate file(s)`,
              effects: matches.map(
                (match): PlanEffect => ({
                  kind: "import",
                  target: match.path,
                  detail: `mapped to ${String(objectField(match.candidate, "movie")?.title ?? "no movie")}`,
                }),
              ),
              warnings: candidateWarnings(matches),
            }
          }
          if (params.movieId === undefined) {
            return yield* toolFail(`${params.name} needs movieId`)
          }
          const movie = yield* readMovie(arr, params.movieId, signal)
          const effect: PlanEffect = {
            kind: "command",
            target: `movie ${params.movieId}: ${movieLabel(movie)}`,
            detail: `${params.name} over ${String(movie.path ?? "its folder")}`,
          }
          const target: JsonValue = {
            movieId: movie.id ?? null,
            path: movie.path ?? null,
          }
          return {
            state: { target },
            summary: `${params.name} for ${movieLabel(movie)}`,
            effects: [effect],
            warnings: [],
          }
        }),
      fingerprint: (state) => state.target,
      apply: (params) =>
        postCommand(arr, {
          name: params.name,
          ...(params.name === "DownloadedMoviesScan"
            ? { path: params.path }
            : {}),
          ...(params.name === "RefreshMovie" && isNumber(params.movieId)
            ? { movieIds: [params.movieId] }
            : {}),
          ...(params.name === "RescanMovie" ? { movieId: params.movieId } : {}),
        }),
      verify: (_params, result) => verifyCommand(arr, result),
    }),
  }
}
