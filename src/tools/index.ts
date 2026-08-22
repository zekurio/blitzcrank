import path from "node:path"

import type { ToolDefinition } from "@earendil-works/pi-coding-agent"

import type { CaseFile } from "../casefile.ts"
import type { Config } from "../config.ts"
import type { SeerrClient } from "../services/seerr.ts"
import { buildRadarrTools } from "./arr-radarr.ts"
import { buildSonarrTools } from "./arr-sonarr.ts"
import { buildCaseFileTool } from "./casefile.ts"
import type { RunContext } from "./context.ts"
import { buildHistoryTool } from "./history.ts"
import { buildJellyfinTools } from "./jellyfin.ts"
import { buildMediaTools } from "./media.ts"
import { buildProgressTool, type StatusComment } from "./progress.ts"
import { buildSabnzbdTools } from "./sabnzbd.ts"
import { buildSeerrTools } from "./seerr.ts"

export type { StatusComment } from "./progress.ts"

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
  /** Known media type; grants one Arr, or neither when unknown. */
  mediaScope: MediaScope
  /** Shared handle to the run's live status comment (posted, then edited). */
  status: StatusComment
  /** This issue's memory; the agent rewrites its summary, the host persists it. */
  casefile: CaseFile
}

/**
 * Issue runs additionally get the live public status comment tool.
 * The known media type grants only its Arr. An unknown type grants neither.
 * This keeps the model's tool surface small and fails closed when Seerr cannot
 * identify the media.
 */
export function buildIssueTools(deps: IssueToolDeps): ToolDefinition[] {
  const tools = buildServiceTools(
    deps.config,
    deps.ctx,
    deps.sessionFileRef,
  ).filter((tool) => {
    const isSonarr = tool.name.startsWith("sonarr_")
    const isRadarr = tool.name.startsWith("radarr_")
    if (!isSonarr && !isRadarr) return true
    if (deps.mediaScope === "movie") return isRadarr
    if (deps.mediaScope === "tv") return isSonarr
    return false
  })
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
