import { StringEnum } from "@earendil-works/pi-ai"
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

import type { ServiceConfig } from "../config.ts"
import { jsonRequest } from "../services/http.ts"
import type { SeerrClient } from "../services/seerr.ts"
import { makeReadTool, reasonParam, runMutation, textResult } from "./common.ts"
import type { RunContext } from "./context.ts"
import { assertSabReadAllowed, assertSeerrLifecycleOwned } from "./safety.ts"

export function buildJellyfinTools(
  cfg: ServiceConfig,
  ctx: RunContext,
): ToolDefinition[] {
  const request = (path: string, method: "GET" | "POST" = "GET") =>
    jsonRequest(cfg.url, path, {
      method,
      headers: { "X-Emby-Token": cfg.apiKey },
    })

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
          evidence: [
            { service: "jellyfin", value: params.itemId, hint: "item id" },
          ],
          perform: () =>
            request(
              `/Items/${encodeURIComponent(params.itemId)}/Refresh`,
              "POST",
            ),
        })
        return textResult(outcome, {
          service: "jellyfin",
          action: "refresh_item",
          itemId: params.itemId,
        })
      },
    }),
  ]
}

export function buildSeerrTools(
  cfg: ServiceConfig,
  ctx: RunContext,
): ToolDefinition[] {
  const request = (path: string) =>
    jsonRequest(cfg.url, path, { headers: { "X-Api-Key": cfg.apiKey } })

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
        mediaId: Type.Integer({
          minimum: 1,
          description: "TMDB id of the media",
        }),
        seasons: Type.Optional(
          Type.Array(Type.Integer({ minimum: 0 }), {
            description: "Season numbers for tv requests",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const outcome = await runMutation(ctx, {
          kind: "mutate",
          evidence: [
            { service: "seerr", value: params.mediaId, hint: "tmdbId" },
          ],
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
            const id = (result as { id?: number } | null)?.id
            if (!id) return { warning: "request response had no id" }
            const created = await request(`/api/v1/request/${id}`)
            ctx.recordRead(
              "seerr",
              `/api/v1/request/${id}`,
              JSON.stringify(created),
            )
            return created
          },
        })
        return textResult(outcome, {
          service: "seerr",
          action: "create_request",
          mediaId: params.mediaId,
        })
      },
    }),
  ]
}

export function buildSabnzbdTools(
  cfg: ServiceConfig,
  ctx: RunContext,
): ToolDefinition[] {
  const service = "sabnzbd" as const

  const sabCall = (params: Record<string, string>) => {
    const url = new URL(cfg.url + "/api")
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value)
    url.searchParams.set("apikey", cfg.apiKey)
    url.searchParams.set("output", "json")
    return jsonRequest(url.origin, url.pathname + url.search, {})
  }

  const verifyList = async (mode: "queue" | "history") => {
    const list = await sabCall({ mode, limit: "50" })
    ctx.recordRead(service, `/api?mode=${mode}&limit=50`, JSON.stringify(list))
    return list
  }

  const nzoEvidence = (nzoId: string) => [
    { service, value: nzoId, hint: "nzo_id" } as const,
  ]

  return [
    makeReadTool(
      {
        service,
        label: "SABnzbd read",
        description:
          "Read SABnzbd state: only /api?mode=queue and /api?mode=history (plus limit=N). Job control goes through the dedicated sabnzbd_* tools.",
        guards: (path) => {
          if (!path.startsWith("/api"))
            throw new Error("SABnzbd path must start with /api")
          assertSabReadAllowed(path)
        },
        request: (path) => {
          const url = new URL(cfg.url + path)
          url.searchParams.set("apikey", cfg.apiKey)
          url.searchParams.set("output", "json")
          return jsonRequest(url.origin, url.pathname + url.search, {})
        },
      },
      ctx,
    ),
    defineTool({
      name: "sabnzbd_retry_job",
      label: "SABnzbd: retry failed job",
      description:
        "Retry one failed SABnzbd history job (moves it back to the queue). Only after the failure cause is understood/fixed. The nzo_id must come from a SABnzbd read this run.",
      parameters: Type.Object({
        reason: reasonParam(),
        nzoId: Type.String({
          minLength: 1,
          description: "SABnzbd nzo_id of the failed history job",
        }),
      }),
      async execute(_toolCallId, params) {
        const outcome = await runMutation(ctx, {
          kind: "mutate",
          evidence: nzoEvidence(params.nzoId),
          perform: () => sabCall({ mode: "retry", value: params.nzoId }),
          verify: () => verifyList("queue"),
        })
        return textResult(outcome, {
          service,
          action: "retry_job",
          nzoId: params.nzoId,
        })
      },
    }),
    defineTool({
      name: "sabnzbd_delete_job",
      label: "SABnzbd: delete job",
      description:
        "Remove one job from the SABnzbd queue or history. deleteFiles=true also deletes downloaded data and is recorded as a deletion. Prefer Arr-level queue removal when the Arr still tracks the item; never orphan an Arr that is waiting on this job. The nzo_id must come from a SABnzbd read on this issue.",
      parameters: Type.Object({
        reason: reasonParam(),
        nzoId: Type.String({ minLength: 1 }),
        from: StringEnum(["queue", "history"] as const),
        deleteFiles: Type.Boolean({
          description:
            "Also delete downloaded data from disk (counts as a deletion)",
        }),
      }),
      async execute(_toolCallId, params) {
        const outcome = await runMutation(ctx, {
          kind: params.deleteFiles ? "delete" : "mutate",
          evidence: nzoEvidence(params.nzoId),
          perform: () =>
            sabCall({
              mode: params.from,
              name: "delete",
              value: params.nzoId,
              del_files: params.deleteFiles ? "1" : "0",
            }),
          verify: () => verifyList(params.from),
        })
        return textResult(outcome, {
          service,
          action: "delete_job",
          from: params.from,
          nzoId: params.nzoId,
        })
      },
    }),
    defineTool({
      name: "sabnzbd_pause_job",
      label: "SABnzbd: pause job",
      description:
        "Pause one SABnzbd queue job. The nzo_id must come from a SABnzbd read this run.",
      parameters: Type.Object({
        reason: reasonParam(),
        nzoId: Type.String({ minLength: 1 }),
      }),
      async execute(_toolCallId, params) {
        const outcome = await runMutation(ctx, {
          kind: "mutate",
          evidence: nzoEvidence(params.nzoId),
          perform: () =>
            sabCall({ mode: "queue", name: "pause", value: params.nzoId }),
          verify: () => verifyList("queue"),
        })
        return textResult(outcome, {
          service,
          action: "pause_job",
          nzoId: params.nzoId,
        })
      },
    }),
    defineTool({
      name: "sabnzbd_resume_job",
      label: "SABnzbd: resume job",
      description:
        "Resume one paused SABnzbd queue job. The nzo_id must come from a SABnzbd read this run.",
      parameters: Type.Object({
        reason: reasonParam(),
        nzoId: Type.String({ minLength: 1 }),
      }),
      async execute(_toolCallId, params) {
        const outcome = await runMutation(ctx, {
          kind: "mutate",
          evidence: nzoEvidence(params.nzoId),
          perform: () =>
            sabCall({ mode: "queue", name: "resume", value: params.nzoId }),
          verify: () => verifyList("queue"),
        })
        return textResult(outcome, {
          service,
          action: "resume_job",
          nzoId: params.nzoId,
        })
      },
    }),
  ]
}

/**
 * The run's single live status comment on the issue. The progress tool posts
 * it once and rewrites it in place afterwards; the host then replaces it with
 * the final public comment (or deletes it when there is nothing to say), so a
 * run never leaves more than one comment behind.
 */
export interface StatusComment {
  id: number | undefined
}

/** Max report_progress calls per run; keeps status churn (and API calls) bounded. */
const MAX_PROGRESS_UPDATES = 4

export function buildProgressTool(
  seerr: SeerrClient,
  issueId: string | number,
  anchor: string,
  language: string,
  status: StatusComment,
): ToolDefinition {
  let calls = 0
  return defineTool({
    name: "report_progress",
    label: "Report issue progress",
    description:
      `Publish or rewrite this run's single live status line: one short user-facing ${language} sentence ` +
      "describing what you are doing right now. Call it as your first action, then again only when the work " +
      `moves to a clearly different phase (max ${MAX_PROGRESS_UPDATES} calls). Each call replaces the previous ` +
      "text instead of adding a comment, and your final response replaces it again. Shown publicly: no internal " +
      "tool names, IDs, URLs, or promises of success.",
    parameters: Type.Object({
      message: Type.String({
        description: `One concise ${language} sentence tailored to this issue`,
      }),
    }),
    async execute(_toolCallId, params) {
      if (calls >= MAX_PROGRESS_UPDATES) {
        throw new Error(
          `report_progress may be called at most ${MAX_PROGRESS_UPDATES} times per run`,
        )
      }
      calls++
      const message = params.message.trim()
      if (!message) throw new Error("message must not be empty")
      const body = `${message}\n\n${anchor}`
      if (status.id === undefined) {
        status.id = await seerr.postComment(issueId, body)
        return textResult(
          { posted: true, replacesPrevious: true },
          { action: "report_progress" },
        )
      }
      await seerr.updateComment(status.id, body)
      return textResult(
        { updated: true, replacesPrevious: true },
        { action: "report_progress" },
      )
    },
  })
}
