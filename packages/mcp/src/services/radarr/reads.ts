import { Effect } from "effect"
import { Type } from "typebox"

import { isNumber, pick } from "../../json.ts"
import { toolFail } from "../../tools/errors.ts"
import { resource } from "../../tools/reads.ts"
import { listResult } from "../../tools/results.ts"
import { arrList, type Arr } from "../arr/client.ts"
import { namesOrNull, scalars } from "../arr/compact.ts"
import { arrSharedReads } from "../arr/reads.ts"
import {
  readReleases,
  RELEASE_REUSE_MINUTES,
  releaseFilterParams,
} from "../arr/releases.ts"
import {
  compactMovie,
  compactMovieFile,
  movieIdParam,
  readMovie,
} from "./movie.ts"

export function radarrReads(arr: Arr) {
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
    movie_files: resource({
      description:
        "Files of one movie with quality, custom formats and score, cutoff status, and media info",
      params: Type.Object({ movieId: movieIdParam }),
      run: (params, signal) =>
        arrList(arr, "/api/v3/moviefile", {
          query: { movieId: params.movieId },
          signal,
        }).pipe(
          Effect.map((files) =>
            listResult(
              files.map((file) => ({
                ...compactMovieFile(file),
                // The file a movie record embeds carries neither of these.
                ...scalars(file, ["customFormatScore"]),
                customFormats: namesOrNull(file.customFormats),
              })),
            ),
          ),
        ),
    }),
    queue: shared.queue,
    history: shared.history,
    blocklist: shared.blocklist,
    quality_profiles: shared.quality_profiles,
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
        "Indexer search for one movie. Grabs nothing. " +
        `One search answers every read of the same movie for ${RELEASE_REUSE_MINUTES} minutes, whatever the filters; searchAgeSeconds is its age. ` +
        "Counts cover every hit; the listing is filtered and capped. " +
        "With no release for the movie it also reads Radarr's health on every call: warnings name each indexer problem, or say health could not be read, and then the list proves nothing about what was published",
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
    manual_import_candidates: shared.manual_import_candidates,
    command_status: shared.command_status,
    health: shared.health,
    disk_space: shared.disk_space,
    download_clients: shared.download_clients,
  }
}
