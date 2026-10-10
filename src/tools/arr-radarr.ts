import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable"
import { Effect } from "effect"
import { Type } from "typebox"

import type { ServiceConfig } from "../config.ts"
import {
  arrReadTool,
  manualImportTool,
  queueAndBlocklistTools,
  readReleases,
  releaseFilterParams,
  runArrCommand,
  runArrFileDelete,
  type JsonObject,
} from "./arr-common.ts"
import { reasonParam, textResult, type ServiceName } from "./common.ts"
import type { RunContext } from "./context.ts"

interface MovieCommand {
  toolName: "radarr_search" | "radarr_refresh_movie"
  label: string
  description: string
  commandName: "MoviesSearch" | "RefreshMovie"
  action: "search" | "refresh_movie"
  idDescription?: string | undefined
}

function movieCommandTool(
  cfg: ServiceConfig,
  ctx: RunContext,
  command: MovieCommand,
): ToolRegistration {
  const service: ServiceName = "radarr"
  const movieId = command.idDescription
    ? Type.Integer({ minimum: 1, description: command.idDescription })
    : Type.Integer({ minimum: 1 })
  return defineTool({
    name: command.toolName,
    description: command.description,
    parameters: Type.Object({
      reason: reasonParam(),
      movieId,
    }),
    execute(params) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const evidence = [
            { service, value: params.movieId, hint: "movie id" },
          ]
          const outcome = yield* runArrCommand(cfg, service, ctx, evidence, {
            name: command.commandName,
            movieIds: [params.movieId],
          })
          return textResult(outcome, {
            service,
            action: command.action,
            movieId: params.movieId,
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
  const service: ServiceName = "radarr"
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
            service,
            ctx,
            path,
            params.movieFileId,
            "moviefile id",
            "movie file",
          )
          return textResult(outcome, {
            service,
            action: "delete_movie_file",
            movieFileId: params.movieFileId,
          })
        }),
      )
    },
  })
}

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
          const service: ServiceName = "radarr"
          const target = {
            path: `/api/v3/release?movieId=${params.movieId}`,
            matches: (release: JsonObject) =>
              release.mappedMovieId === params.movieId,
          }
          const result = yield* readReleases(service, cfg, ctx, target, params)
          return textResult(result, {
            service,
            action: "releases",
            path: target.path,
          })
        }),
      )
    },
  })
}

export function buildRadarrTools(
  cfg: ServiceConfig,
  ctx: RunContext,
): ToolRegistration[] {
  const service: ServiceName = "radarr"
  return [
    arrReadTool(
      service,
      cfg,
      ctx,
      "Radarr read",
      "Check movie availability and release dates in Radarr via GET /api/v3 paths: " +
        "movie for tracking/monitoring, moviefile for imported files, queue/history for acquisition, " +
        "calendar for cinema/digital/physical dates, blocklist. " +
        "Load the radarr skill for exact availability/date workflows.",
    ),
    radarrReleasesTool(cfg, ctx),
    movieCommandTool(cfg, ctx, {
      toolName: "radarr_search",
      label: "Radarr: trigger movie search",
      description:
        "Trigger a Radarr search for one movie (MoviesSearch). The movie id must come from a Radarr read this run.",
      commandName: "MoviesSearch",
      action: "search",
      idDescription: "Internal Radarr movie id (not tmdbId)",
    }),
    deleteMovieFileTool(cfg, ctx),
    movieCommandTool(cfg, ctx, {
      toolName: "radarr_refresh_movie",
      label: "Radarr: refresh movie",
      description:
        "Refresh a movie's metadata and rescan its files (RefreshMovie). The movie id must come from a Radarr read this run.",
      commandName: "RefreshMovie",
      action: "refresh_movie",
    }),
    manualImportTool(service, cfg, ctx),
    ...queueAndBlocklistTools(service, cfg, ctx),
  ]
}
