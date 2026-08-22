import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

import type { ServiceConfig } from "../config.ts"
import {
  arrReadTool,
  manualImportTool,
  queueAndBlocklistTools,
  runArrCommand,
  runArrFileDelete,
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
): ToolDefinition {
  const service: ServiceName = "radarr"
  const movieId = command.idDescription
    ? Type.Integer({ minimum: 1, description: command.idDescription })
    : Type.Integer({ minimum: 1 })
  return defineTool({
    name: command.toolName,
    label: command.label,
    description: command.description,
    parameters: Type.Object({
      reason: reasonParam(),
      movieId,
    }),
    async execute(_toolCallId, params) {
      const evidence = [{ service, value: params.movieId, hint: "movie id" }]
      const outcome = await runArrCommand(cfg, service, ctx, evidence, {
        name: command.commandName,
        movieIds: [params.movieId],
      })
      return textResult(outcome, {
        service,
        action: command.action,
        movieId: params.movieId,
      })
    },
  })
}

function deleteMovieFileTool(
  cfg: ServiceConfig,
  ctx: RunContext,
): ToolDefinition {
  const service: ServiceName = "radarr"
  return defineTool({
    name: "radarr_delete_movie_file",
    label: "Radarr: delete movie file",
    description:
      "Delete one movie file from disk (e.g. verified corrupt), so a replacement can be searched. This removes the only copy of the movie — evidence must be strong. The moviefile id must come from a Radarr read on this issue.",
    parameters: Type.Object({
      reason: reasonParam(),
      movieFileId: Type.Integer({ minimum: 1 }),
    }),
    async execute(_toolCallId, params) {
      const path = `/api/v3/moviefile/${params.movieFileId}`
      const outcome = await runArrFileDelete(
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
    },
  })
}

export function buildRadarrTools(
  cfg: ServiceConfig,
  ctx: RunContext,
): ToolDefinition[] {
  const service: ServiceName = "radarr"
  return [
    arrReadTool(
      service,
      cfg,
      ctx,
      "Radarr read",
      "Read Radarr (movies) state via /api/v3 paths: movie, moviefile, queue, history, blocklist.",
    ),
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
