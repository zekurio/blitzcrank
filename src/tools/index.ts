import path from "node:path"

import type { ToolDefinition } from "@earendil-works/pi-coding-agent"

import type { CaseFile } from "../casefile.ts"
import type { Config } from "../config.ts"
import type { SeerrClient } from "../services/seerr.ts"
import { buildRadarrTools, buildSonarrTools } from "./arr.ts"
import { buildCaseFileTool } from "./casefile.ts"
import type { RunContext } from "./context.ts"
import { buildHistoryTool } from "./history.ts"
import { buildMediaTools } from "./media.ts"
import {
  buildJellyfinTools,
  buildProgressTool,
  buildSabnzbdTools,
  buildSeerrTools,
  type StatusComment,
} from "./services.ts"

export type { StatusComment } from "./services.ts"

export interface SessionFileRef {
  current: string | undefined
}

/**
 * Service tool set shared by issue runs and automations: GET-only reads,
 * typed evidence-gated mutations, media probing, and run-history search.
 */
export function buildServiceTools(
  config: Config,
  ctx: RunContext,
  sessionFileRef: SessionFileRef,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [...buildSeerrTools(config.seerr, ctx)]
  if (config.sonarr) {
    tools.push(
      ...buildSonarrTools(config.sonarr, ctx, config.media !== undefined),
    )
  }
  if (config.radarr) tools.push(...buildRadarrTools(config.radarr, ctx))
  if (config.jellyfin) tools.push(...buildJellyfinTools(config.jellyfin, ctx))
  if (config.sabnzbd) tools.push(...buildSabnzbdTools(config.sabnzbd, ctx))
  if (config.media) tools.push(...buildMediaTools(config.media, ctx))
  tools.push(
    buildHistoryTool(path.join(config.dataDir, "sessions"), sessionFileRef),
  )
  return tools
}

/**
 * Tools that cannot change service state, enumerated deliberately. Automations
 * register these unconditionally, so a naming convention must never decide
 * this allowlist: `seerr_create_request` is a mutation despite its suffix.
 *
 * Enumeration fails safely. A new read is withheld until listed here; a new
 * mutation can never be granted to every automation by accident.
 */
const READ_TOOLS = new Set([
  "jellyfin_request",
  "media_probe",
  "radarr_request",
  "sabnzbd_request",
  "seerr_request",
  "sonarr_request",
  "thread_history_search",
])

export function isReadTool(name: string): boolean {
  return READ_TOOLS.has(name)
}

export type MediaScope = "movie" | "tv" | undefined

export interface IssueToolDeps {
  config: Config
  ctx: RunContext
  seerr: SeerrClient
  issueId: string | number
  /** Model identity footer appended to public comments, e.g. "[blitzcrank w/ ...]". */
  anchor: string
  sessionFileRef: SessionFileRef
  /** Known media type of the issue; prunes the irrelevant Arr's tools. */
  mediaScope: MediaScope
  /** Shared handle to the run's live status comment (posted, then edited). */
  status: StatusComment
  /** This issue's memory; the agent rewrites its summary, the host persists it. */
  casefile: CaseFile
}

/**
 * Issue runs additionally get the live public status comment tool.
 * When the webhook names the media type, the other Arr's tools are omitted
 * entirely — a movie issue never needs Sonarr and vice versa — keeping the
 * tool surface small for the model.
 */
export function buildIssueTools(deps: IssueToolDeps): ToolDefinition[] {
  const droppedPrefix =
    deps.mediaScope === "movie"
      ? "sonarr_"
      : deps.mediaScope === "tv"
        ? "radarr_"
        : undefined
  const tools = buildServiceTools(
    deps.config,
    deps.ctx,
    deps.sessionFileRef,
  ).filter((tool) => !droppedPrefix || !tool.name.startsWith(droppedPrefix))
  return [
    buildProgressTool(
      deps.seerr,
      deps.issueId,
      deps.anchor,
      deps.config.language,
      deps.status,
    ),
    buildCaseFileTool(deps.casefile),
    ...tools,
  ]
}
