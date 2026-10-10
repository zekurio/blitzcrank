import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable"
import { Effect } from "effect"
import { Type } from "typebox"

import type { ServiceConfig } from "../config.ts"
import {
  arrRequestTool,
  deleteQueueItemTool,
  readReleases,
  releaseFilterParams,
  runArrFileDelete,
  runArrMonitoringUpdate,
  type ArrRecord,
} from "./arr-common.ts"
import { reasonParam, textResult, type HostTool } from "./common.ts"
import type { RunContext } from "./context.ts"

function radarrReleasesTool(
  cfg: ServiceConfig,
  ctx: RunContext,
): ToolRegistration {
  return defineTool({
    name: "radarr_releases",
    replay: "safe",
    description:
      "List indexer release candidates for one movie with Radarr's decision: approved, rejections, custom-format score, " +
      "publish date, and languages. Runs a live indexer search; grabs nothing. Counts cover every hit. The listing keeps " +
      "Radarr's preference order and is filtered and capped, so when matchingFilters exceeds listed, narrow with " +
      "publishedAfter, titleContains, or approvedOnly before concluding a release is absent. Releases Radarr mapped to " +
      "another movie are only counted.",
    parameters: Type.Object({
      ...releaseFilterParams(),
      movieId: Type.Integer({
        minimum: 1,
        description: "Internal Radarr movie id (not tmdbId)",
      }),
    }),
    execute(params) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const target = {
            path: `/api/v3/release?movieId=${params.movieId}`,
            matches: (release: ArrRecord) =>
              release.mappedMovieId === params.movieId,
          }
          const result = yield* readReleases("radarr", cfg, ctx, target, params)
          return textResult(result, {
            service: "radarr",
            action: "releases",
            path: target.path,
          })
        }),
      )
    },
  })
}

function deleteMovieFileTool(
  cfg: ServiceConfig,
  ctx: RunContext,
): ToolRegistration {
  return defineTool({
    name: "radarr_delete_movie_file",
    description:
      "Delete one movie file from disk (e.g. verified corrupt), so a replacement can be searched. This removes the only copy of the movie — evidence must be strong. The moviefile id must pass the Radarr evidence gate.",
    parameters: Type.Object({
      reason: reasonParam(),
      movieFileId: Type.Integer({ minimum: 1 }),
    }),
    execute(params) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const path = `/api/v3/moviefile/${params.movieFileId}`
          const outcome = yield* runArrFileDelete(
            cfg,
            "radarr",
            ctx,
            path,
            params.movieFileId,
            "moviefile id",
            "movie file",
          )
          return textResult(outcome, {
            service: "radarr",
            action: "delete_movie_file",
            movieFileId: params.movieFileId,
          })
        }),
      )
    },
  })
}

function setMovieMonitoringTool(
  cfg: ServiceConfig,
  ctx: RunContext,
): ToolRegistration {
  return defineTool({
    name: "radarr_set_movie_monitoring",
    description:
      "Change whether Radarr monitors a movie. Reads the current movie and sends it back with only " +
      "monitored changed, so path, profile, identity, and availability stay as they are. " +
      "The movie id must pass the Radarr evidence gate.",
    parameters: Type.Object({
      reason: reasonParam(),
      movieId: Type.Integer({
        minimum: 1,
        description: "Internal Radarr movie id (not tmdbId)",
      }),
      monitored: Type.Boolean(),
    }),
    execute(params) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const outcome = yield* runArrMonitoringUpdate(cfg, "radarr", ctx, {
            path: `/api/v3/movie/${params.movieId}`,
            id: params.movieId,
            hint: "movie id",
            identity: "tmdbId",
            preserved: [
              "tmdbId",
              "path",
              "qualityProfileId",
              "minimumAvailability",
              "tags",
            ],
            patch: (record) => ({ ...record, monitored: params.monitored }),
            monitoring: (record) => ({ monitored: record.monitored ?? null }),
          })
          return textResult(outcome, {
            service: "radarr",
            action: "set_movie_monitoring",
            movieId: params.movieId,
          })
        }),
      )
    },
  })
}

export function buildRadarrTools(
  cfg: ServiceConfig,
  ctx: RunContext,
): HostTool[] {
  return [
    arrRequestTool(
      "radarr",
      cfg,
      ctx,
      "Radarr API under /api/v3. GET reads movies, files, queue, history, calendar, blocklist, " +
        "and profiles. Writes: POST command (MoviesSearch, RefreshMovie, RescanMovie, " +
        "ManualImport, DownloadedMoviesScan, RefreshMonitoredDownloads), POST queue/grab/{id}, " +
        "POST history/failed/{id}, DELETE blocklist/{id}, POST release, and DELETE queue/{id}?removeFromClient=false. " +
        "Release candidates go through radarr_releases, monitoring through radarr_set_movie_monitoring, deletions through the delete tools; server settings " +
        "are refused. Load the radarr skill for workflows.",
    ),
    radarrReleasesTool(cfg, ctx),
    setMovieMonitoringTool(cfg, ctx),
    deleteMovieFileTool(cfg, ctx),
    deleteQueueItemTool("radarr", cfg, ctx),
  ]
}
