import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ServiceConfig } from "../config.js";
import { jsonRequest, HttpError } from "../services/http.js";
import type { RunContext } from "./context.js";
import { makeReadTool, reasonParam, runMutation, textResult, type ServiceName } from "./common.js";

/**
 * Sonarr/Radarr tools. Mutation surface mirrors the legacy allowlist exactly:
 *  sonarr: EpisodeSearch/SeasonSearch/SeriesSearch/RefreshSeries commands,
 *          queue grab/delete, blocklist delete, episodefile delete
 *  radarr: MoviesSearch/RefreshMovie commands, queue grab/delete,
 *          blocklist delete (movie-file deletion is NOT authorized)
 */

function arrRequest(cfg: ServiceConfig, path: string, method: "GET" | "POST" | "DELETE" = "GET", body?: unknown) {
  return jsonRequest(cfg.url, path, {
    method,
    headers: { "X-Api-Key": cfg.apiKey },
    ...(body !== undefined ? { body } : {}),
  });
}

/** Follow-up read on the queued command so the model can see it was accepted. */
async function verifyCommand(cfg: ServiceConfig, service: ServiceName, ctx: RunContext, result: unknown) {
  const id = (result as { id?: number } | null)?.id;
  if (!id) return { warning: "command response had no id; verify manually via GET /api/v3/command" };
  const status = await arrRequest(cfg, `/api/v3/command/${id}`);
  ctx.recordRead(service, `/api/v3/command/${id}`, JSON.stringify(status));
  return status;
}

async function verifyQueue(cfg: ServiceConfig, service: ServiceName, ctx: RunContext) {
  const queue = await arrRequest(cfg, `/api/v3/queue?pageSize=100`);
  ctx.recordRead(service, `/api/v3/queue?pageSize=100`, JSON.stringify(queue));
  return queue;
}

function queueAndBlocklistTools(service: ServiceName, cfg: ServiceConfig, ctx: RunContext): ToolDefinition[] {
  return [
    defineTool({
      name: `${service}_delete_queue_item`,
      label: `${service}: remove queue item`,
      description: `Remove a stuck/failed download from the ${service} queue, optionally blocklisting the release and removing it from the download client. The queue item id must come from a queue read this run.`,
      parameters: Type.Object({
        reason: reasonParam(),
        queueId: Type.Integer({ minimum: 1 }),
        blocklist: Type.Boolean({
          description: "Blocklist the release so it is not grabbed again (default true)",
        }),
        removeFromClient: Type.Boolean({
          description: "Also remove the job from the download client (default true)",
        }),
      }),
      async execute(_toolCallId, params) {
        const outcome = await runMutation(ctx, {
          kind: "mutate",
          evidence: [{ service, value: params.queueId, hint: "queue item id" }],
          perform: () =>
            arrRequest(
              cfg,
              `/api/v3/queue/${params.queueId}?removeFromClient=${params.removeFromClient}&blocklist=${params.blocklist}`,
              "DELETE",
            ),
          verify: () => verifyQueue(cfg, service, ctx),
        });
        return textResult(outcome, { service, action: "delete_queue_item", queueId: params.queueId });
      },
    }),
    defineTool({
      name: `${service}_grab_queue_item`,
      label: `${service}: force-grab queue item`,
      description: `Force ${service} to grab a pending/delayed queue item now. The queue item id must come from a queue read this run.`,
      parameters: Type.Object({
        reason: reasonParam(),
        queueId: Type.Integer({ minimum: 1 }),
      }),
      async execute(_toolCallId, params) {
        const outcome = await runMutation(ctx, {
          kind: "mutate",
          evidence: [{ service, value: params.queueId, hint: "queue item id" }],
          perform: () => arrRequest(cfg, `/api/v3/queue/grab/${params.queueId}`, "POST"),
          verify: () => verifyQueue(cfg, service, ctx),
        });
        return textResult(outcome, { service, action: "grab_queue_item", queueId: params.queueId });
      },
    }),
    defineTool({
      name: `${service}_remove_from_blocklist`,
      label: `${service}: remove blocklist entry`,
      description: `Remove one entry from the ${service} blocklist so that release can be grabbed again. The blocklist entry id must come from a blocklist read this run.`,
      parameters: Type.Object({
        reason: reasonParam(),
        blocklistId: Type.Integer({ minimum: 1 }),
      }),
      async execute(_toolCallId, params) {
        const outcome = await runMutation(ctx, {
          kind: "mutate",
          evidence: [{ service, value: params.blocklistId, hint: "blocklist entry id" }],
          perform: () => arrRequest(cfg, `/api/v3/blocklist/${params.blocklistId}`, "DELETE"),
        });
        return textResult(outcome, { service, action: "remove_from_blocklist", blocklistId: params.blocklistId });
      },
    }),
  ];
}

export function buildSonarrTools(cfg: ServiceConfig, ctx: RunContext): ToolDefinition[] {
  const service: ServiceName = "sonarr";
  return [
    makeReadTool(
      {
        service,
        label: "Sonarr read",
        description:
          "Read Sonarr (TV) state via /api/v3 paths: series, episode, episodefile, queue, history, blocklist, wanted/missing.",
        request: (path) => arrRequest(cfg, path),
      },
      ctx,
    ),
    defineTool({
      name: "sonarr_search",
      label: "Sonarr: trigger search",
      description:
        "Trigger a Sonarr search: whole series, one season, or specific episodes. The series id (and episode ids, if given) must come from Sonarr reads this run.",
      parameters: Type.Object({
        reason: reasonParam(),
        seriesId: Type.Integer({ minimum: 1, description: "Internal Sonarr series id (not tvdbId)" }),
        seasonNumber: Type.Optional(Type.Integer({ minimum: 0 })),
        episodeIds: Type.Optional(
          Type.Array(Type.Integer({ minimum: 1 }), {
            description: "Internal Sonarr episode ids for a targeted EpisodeSearch",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const command =
          params.episodeIds && params.episodeIds.length > 0
            ? { name: "EpisodeSearch", episodeIds: params.episodeIds }
            : params.seasonNumber !== undefined
              ? { name: "SeasonSearch", seriesId: params.seriesId, seasonNumber: params.seasonNumber }
              : { name: "SeriesSearch", seriesId: params.seriesId };
        const outcome = await runMutation(ctx, {
          kind: "mutate",
          evidence: [
            { service, value: params.seriesId, hint: "series id" },
            ...(params.episodeIds ?? []).map((id) => ({ service, value: id, hint: "episode id" })),
          ],
          perform: () => arrRequest(cfg, "/api/v3/command", "POST", command),
          verify: (result) => verifyCommand(cfg, service, ctx, result),
        });
        return textResult(outcome, { service, action: "search", command: command.name });
      },
    }),
    defineTool({
      name: "sonarr_refresh_series",
      label: "Sonarr: refresh series",
      description:
        "Refresh a series' metadata and rescan its files (RefreshSeries). The series id must come from a Sonarr read this run.",
      parameters: Type.Object({
        reason: reasonParam(),
        seriesId: Type.Integer({ minimum: 1 }),
      }),
      async execute(_toolCallId, params) {
        const outcome = await runMutation(ctx, {
          kind: "mutate",
          evidence: [{ service, value: params.seriesId, hint: "series id" }],
          perform: () =>
            arrRequest(cfg, "/api/v3/command", "POST", { name: "RefreshSeries", seriesId: params.seriesId }),
          verify: (result) => verifyCommand(cfg, service, ctx, result),
        });
        return textResult(outcome, { service, action: "refresh_series", seriesId: params.seriesId });
      },
    }),
    defineTool({
      name: "sonarr_delete_episode_file",
      label: "Sonarr: delete episode file",
      description:
        "Delete one episode file from disk (e.g. verified corrupt), so a replacement can be searched. Deletion budget applies; the episodefile id must come from a Sonarr read this run.",
      parameters: Type.Object({
        reason: reasonParam(),
        episodeFileId: Type.Integer({ minimum: 1 }),
      }),
      async execute(_toolCallId, params) {
        const outcome = await runMutation(ctx, {
          kind: "delete",
          evidence: [{ service, value: params.episodeFileId, hint: "episodefile id" }],
          perform: () => arrRequest(cfg, `/api/v3/episodefile/${params.episodeFileId}`, "DELETE"),
          verify: async () => {
            try {
              const still = await arrRequest(cfg, `/api/v3/episodefile/${params.episodeFileId}`);
              return { warning: "episode file still present after delete", body: still };
            } catch (err) {
              if (err instanceof HttpError && err.status === 404) {
                return { confirmed: "episode file no longer present (HTTP 404)" };
              }
              throw err;
            }
          },
        });
        return textResult(outcome, { service, action: "delete_episode_file", episodeFileId: params.episodeFileId });
      },
    }),
    ...queueAndBlocklistTools(service, cfg, ctx),
  ];
}

export function buildRadarrTools(cfg: ServiceConfig, ctx: RunContext): ToolDefinition[] {
  const service: ServiceName = "radarr";
  return [
    makeReadTool(
      {
        service,
        label: "Radarr read",
        description:
          "Read Radarr (movies) state via /api/v3 paths: movie, moviefile, queue, history, blocklist.",
        request: (path) => arrRequest(cfg, path),
      },
      ctx,
    ),
    defineTool({
      name: "radarr_search",
      label: "Radarr: trigger movie search",
      description:
        "Trigger a Radarr search for one movie (MoviesSearch). The movie id must come from a Radarr read this run.",
      parameters: Type.Object({
        reason: reasonParam(),
        movieId: Type.Integer({ minimum: 1, description: "Internal Radarr movie id (not tmdbId)" }),
      }),
      async execute(_toolCallId, params) {
        const outcome = await runMutation(ctx, {
          kind: "mutate",
          evidence: [{ service, value: params.movieId, hint: "movie id" }],
          perform: () =>
            arrRequest(cfg, "/api/v3/command", "POST", { name: "MoviesSearch", movieIds: [params.movieId] }),
          verify: (result) => verifyCommand(cfg, service, ctx, result),
        });
        return textResult(outcome, { service, action: "search", movieId: params.movieId });
      },
    }),
    defineTool({
      name: "radarr_refresh_movie",
      label: "Radarr: refresh movie",
      description:
        "Refresh a movie's metadata and rescan its files (RefreshMovie). The movie id must come from a Radarr read this run.",
      parameters: Type.Object({
        reason: reasonParam(),
        movieId: Type.Integer({ minimum: 1 }),
      }),
      async execute(_toolCallId, params) {
        const outcome = await runMutation(ctx, {
          kind: "mutate",
          evidence: [{ service, value: params.movieId, hint: "movie id" }],
          perform: () =>
            arrRequest(cfg, "/api/v3/command", "POST", { name: "RefreshMovie", movieIds: [params.movieId] }),
          verify: (result) => verifyCommand(cfg, service, ctx, result),
        });
        return textResult(outcome, { service, action: "refresh_movie", movieId: params.movieId });
      },
    }),
    ...queueAndBlocklistTools(service, cfg, ctx),
  ];
}
