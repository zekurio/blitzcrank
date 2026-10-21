import { Effect } from "effect"
import { Type } from "typebox"

import type { JsonValue } from "../../http.ts"
import { isJsonObject, isNumber, objectField } from "../../json.ts"
import { toolFail } from "../../tools/errors.ts"
import { action, type WriteEffect } from "../../tools/writes.ts"
import { arrObject, arrRequest, type Arr } from "../arr/client.ts"
import { postCommand, verifyCommand, verifyDeleted } from "../arr/commands.ts"
import { qualityName, sizeText } from "../arr/compact.ts"
import {
  candidateFile,
  candidateWarnings,
  folderScanAction,
  manualImportScope,
  matchCandidates,
} from "../arr/manual-import.ts"
import {
  arrRecord,
  monitoringReadBack,
  type MonitoringUpdate,
} from "../arr/monitoring.ts"
import { arrSharedActions } from "../arr/writes.ts"
import { compactMovie, movieIdParam, movieLabel, readMovie } from "./movie.ts"

const manualImportFile = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      description:
        "Candidate path, exactly as radarr_manual_import_candidates has it",
    }),
    movieId: movieIdParam,
  },
  { additionalProperties: false },
)

const COMMANDS = [
  "RefreshMovie",
  "RescanMovie",
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

export function radarrActions(arr: Arr) {
  const shared = arrSharedActions(arr)
  return {
    auto_search: action({
      description:
        "Search indexers for one movie. Radarr picks and grabs the release",
      params: Type.Object({ movieId: movieIdParam }),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          const movie = yield* readMovie(arr, params.movieId, signal)
          const label = movieLabel(movie)
          const effect: WriteEffect = {
            kind: "search",
            target: `movie ${params.movieId}: ${label}`,
            detail:
              movie.hasFile === true
                ? "has a file that a grab may replace"
                : "has no file",
          }
          return {
            state: null,
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
      write: (params) =>
        postCommand(arr, { name: "MoviesSearch", movieIds: [params.movieId] }),
      verify: (_params, result) => verifyCommand(arr, result),
    }),
    set_movie_monitoring: action({
      description:
        "Change whether Radarr monitors a movie. Every other movie field is kept",
      params: Type.Object({ movieId: movieIdParam, monitored: Type.Boolean() }),
      lock: (params) => `movie:${params.movieId}`,
      resolve: (params, signal) =>
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
          const effect: WriteEffect = {
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
      write: (params, state) =>
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
    delete_movie_file: action({
      description:
        "Delete one movie file from disk so a replacement can be searched",
      params: Type.Object({ movieFileId: Type.Integer({ minimum: 1 }) }),
      resolve: (params, signal) =>
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
          const effect: WriteEffect = {
            kind: "delete",
            target: path,
            detail: `${sizeText(file.size)}; the file of ${label}`,
          }
          return {
            state: null,
            summary: `Delete movie file ${params.movieFileId} (${path}, ${sizeText(file.size)}) of ${label}`,
            effects: [effect],
            warnings: ["this removes the movie's only copy from disk"],
          }
        }),
      write: (params) =>
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
    remove_queue_item: shared.remove_queue_item,
    mark_history_failed: shared.mark_history_failed,
    delete_blocklist_entry: shared.delete_blocklist_entry,
    grab_release: shared.grab_release,
    manual_import: action({
      description:
        "Import files Radarr offers as manual-import candidates into named movies. " +
        "Quality, languages, and release group come from the live candidate",
      params: Type.Object({
        files: Type.Array(manualImportFile, { minItems: 1, maxItems: 50 }),
        importMode: Type.Enum(["auto", "move", "copy"], {
          description: "auto follows the download client's setting",
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
          const effects = params.files.map((file): WriteEffect => {
            const movie = movies.get(file.movieId)
            const match = matches.find((entry) => entry.path === file.path)
            return {
              kind: "import",
              target: file.path,
              detail: `${params.importMode} into ${movie ? movieLabel(movie) : `movie ${file.movieId}`} as ${String(qualityName(match?.candidate.quality) ?? "unknown quality")}`,
            }
          })
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
                movieId: file.movieId,
              },
            ]
          }),
        }),
      verify: (_params, result) => verifyCommand(arr, result),
    }),
    scan_import_folder: folderScanAction(arr, (candidate) =>
      String(objectField(candidate, "movie")?.title ?? "no movie"),
    ),
    run_command: action({
      description:
        "Make Radarr re-read disk or downloader state. RefreshMovie and RescanMovie need movieId; RefreshMonitoredDownloads covers every download and takes none",
      params: Type.Object({
        name: Type.Enum(COMMANDS),
        movieId: Type.Optional(movieIdParam),
      }),
      resolve: (params, signal) =>
        Effect.gen(function* () {
          if (params.name === "RefreshMonitoredDownloads") {
            if (params.movieId !== undefined) {
              return yield* toolFail(
                "RefreshMonitoredDownloads covers every download and takes no movieId",
              )
            }
            const effect: WriteEffect = {
              kind: "command",
              target: "download clients",
              detail: "RefreshMonitoredDownloads",
            }
            return {
              state: null,
              summary:
                "Re-check every monitored download in the download clients",
              effects: [effect],
              warnings: [],
            }
          }
          if (params.movieId === undefined) {
            return yield* toolFail(`${params.name} needs movieId`)
          }
          const movie = yield* readMovie(arr, params.movieId, signal)
          const effect: WriteEffect = {
            kind: "command",
            target: `movie ${params.movieId}: ${movieLabel(movie)}`,
            detail: `${params.name} over ${String(movie.path ?? "its folder")}`,
          }
          return {
            state: null,
            summary: `${params.name} for ${movieLabel(movie)}`,
            effects: [effect],
            warnings: [],
          }
        }),
      write: (params) =>
        postCommand(arr, {
          name: params.name,
          ...(params.name === "RefreshMovie" && isNumber(params.movieId)
            ? { movieIds: [params.movieId] }
            : {}),
          ...(params.name === "RescanMovie" ? { movieId: params.movieId } : {}),
        }),
      verify: (_params, result) => verifyCommand(arr, result),
    }),
  }
}
