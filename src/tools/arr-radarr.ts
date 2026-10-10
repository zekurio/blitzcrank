import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable"
import { Effect } from "effect"
import { Type } from "typebox"

import type { ServiceConfig } from "../config.ts"
import {
  arrRequestTool,
  deleteQueueItemTool,
  runArrFileDelete,
} from "./arr-common.ts"
import { reasonParam, textResult, type HostTool } from "./common.ts"
import type { RunContext } from "./context.ts"

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

export function buildRadarrTools(
  cfg: ServiceConfig,
  ctx: RunContext,
): HostTool[] {
  return [
    arrRequestTool(
      "radarr",
      cfg,
      ctx,
      "Radarr API under /api/v3. GET reads movies, files, queue, history, releases, calendar, blocklist, " +
        "and profiles. Writes: PUT movie/{id} monitoring, POST command (MoviesSearch, RefreshMovie, RescanMovie, " +
        "ManualImport, DownloadedMoviesScan, RefreshMonitoredDownloads), POST queue/grab/{id}, " +
        "POST history/failed/{id}, DELETE blocklist/{id}, POST release, and DELETE queue/{id}?removeFromClient=false. " +
        "Deletions go through the delete tools; server settings are refused. Load the radarr skill for workflows.",
    ),
    deleteMovieFileTool(cfg, ctx),
    deleteQueueItemTool("radarr", cfg, ctx),
  ]
}
