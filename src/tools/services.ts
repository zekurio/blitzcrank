import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ServiceConfig } from "../config.js";
import { jsonRequest } from "../services/http.js";
import type { SeerrClient } from "../services/seerr.js";
import type { RunContext } from "./context.js";
import { makeReadTool, reasonParam, runMutation, textResult } from "./common.js";
import { assertSabReadAllowed, assertSeerrLifecycleOwned } from "./safety.js";

export function buildJellyfinTools(cfg: ServiceConfig, ctx: RunContext): ToolDefinition[] {
  const request = (path: string, method: "GET" | "POST" = "GET") =>
    jsonRequest(cfg.url, path, { method, headers: { "X-Emby-Token": cfg.apiKey } });

  return [
    makeReadTool(
      {
        service: "jellyfin",
        label: "Jellyfin read",
        description:
          "Read Jellyfin state: /Items?... searches, item details with MediaSources (codecs, audio/subtitle streams), /System/Info, /Sessions.",
        request: (path) => request(path),
      },
      ctx,
    ),
    defineTool({
      name: "jellyfin_refresh_item",
      label: "Jellyfin: refresh item",
      description:
        "Trigger a metadata refresh for one Jellyfin item. The item id must come from a Jellyfin read this run.",
      parameters: Type.Object({
        reason: reasonParam(),
        itemId: Type.String({ minLength: 1 }),
      }),
      async execute(_toolCallId, params) {
        const outcome = await runMutation(ctx, {
          kind: "mutate",
          evidence: [{ service: "jellyfin", value: params.itemId, hint: "item id" }],
          perform: () => request(`/Items/${encodeURIComponent(params.itemId)}/Refresh`, "POST"),
        });
        return textResult(outcome, { service: "jellyfin", action: "refresh_item", itemId: params.itemId });
      },
    }),
  ];
}

export function buildSeerrTools(
  cfg: ServiceConfig,
  seerr: SeerrClient,
  ctx: RunContext,
): ToolDefinition[] {
  const request = (path: string) =>
    jsonRequest(cfg.url, path, { headers: { "X-Api-Key": cfg.apiKey } });

  return [
    makeReadTool(
      {
        service: "seerr",
        label: "Seerr read",
        description:
          "Read Jellyseerr state via /api/v1 paths: issue details (/api/v1/issue/{id}), requests, media. Comments and issue status are host-owned.",
        guards: assertSeerrLifecycleOwned,
        request,
      },
      ctx,
    ),
    defineTool({
      name: "seerr_create_request",
      label: "Seerr: create media request",
      description:
        "Create a new Jellyseerr media request (e.g. re-request media that was reported missing and is absent from the Arr). The tmdbId must come from a read this run.",
      parameters: Type.Object({
        reason: reasonParam(),
        mediaType: StringEnum(["movie", "tv"] as const),
        mediaId: Type.Integer({ minimum: 1, description: "TMDB id of the media" }),
        seasons: Type.Optional(
          Type.Array(Type.Integer({ minimum: 0 }), { description: "Season numbers for tv requests" }),
        ),
      }),
      async execute(_toolCallId, params) {
        const outcome = await runMutation(ctx, {
          kind: "mutate",
          evidence: [{ service: "seerr", value: params.mediaId, hint: "tmdbId" }],
          perform: () =>
            jsonRequest(cfg.url, "/api/v1/request", {
              method: "POST",
              headers: { "X-Api-Key": cfg.apiKey },
              body: {
                mediaType: params.mediaType,
                mediaId: params.mediaId,
                ...(params.seasons ? { seasons: params.seasons } : {}),
              },
            }),
          verify: async (result) => {
            const id = (result as { id?: number } | null)?.id;
            if (!id) return { warning: "request response had no id" };
            const created = await request(`/api/v1/request/${id}`);
            ctx.recordRead("seerr", `/api/v1/request/${id}`, JSON.stringify(created));
            return created;
          },
        });
        return textResult(outcome, { service: "seerr", action: "create_request", mediaId: params.mediaId });
      },
    }),
  ];
}

export function buildSabnzbdTools(cfg: ServiceConfig, ctx: RunContext): ToolDefinition[] {
  return [
    makeReadTool(
      {
        service: "sabnzbd",
        label: "SABnzbd read",
        description:
          "Read SABnzbd state. Strictly read-only by policy: only /api?mode=queue and /api?mode=history (plus limit=N). Failed downloads are handled through the Arrs, never directly in SAB.",
        guards: (path) => {
          if (!path.startsWith("/api")) throw new Error("SABnzbd path must start with /api");
          assertSabReadAllowed(path);
        },
        request: (path) => {
          const url = new URL(cfg.url + path);
          url.searchParams.set("apikey", cfg.apiKey);
          url.searchParams.set("output", "json");
          return jsonRequest(url.origin, url.pathname + url.search, {});
        },
      },
      ctx,
    ),
  ];
}

/** Posts one early public progress comment on the issue; enforced single-use. */
export function buildProgressTool(
  seerr: SeerrClient,
  issueId: string | number,
  commentHeader: string,
  language: string,
): ToolDefinition {
  let used = false;
  return defineTool({
    name: "report_progress",
    label: "Report issue progress",
    description:
      `Publish one short user-facing ${language} sentence describing what you are about to investigate or fix. ` +
      "Call this exactly once as your first action. It is shown publicly: no internal tool names, IDs, URLs, or promises of success.",
    parameters: Type.Object({
      message: Type.String({
        description: `One concise ${language} sentence tailored to this issue`,
      }),
    }),
    async execute(_toolCallId, params) {
      if (used) throw new Error("report_progress may only be called once per run");
      used = true;
      const message = params.message.trim();
      if (!message) throw new Error("message must not be empty");
      await seerr.postComment(issueId, `${commentHeader}\n\n${message}`);
      return textResult({ reported: true }, { action: "report_progress" });
    },
  });
}
