import type { CaseFile } from "../casefile.ts"
import type { Config } from "../config.ts"
import type { SeerrClient } from "../services/seerr.ts"
import { buildRadarrTools } from "./arr-radarr.ts"
import { buildSonarrTools } from "./arr-sonarr.ts"
import { buildCaseFileTool } from "./casefile.ts"
import type { HostTool } from "./common.ts"
import type { RunContext } from "./context.ts"
import { buildHistoryTool } from "./history.ts"
import { buildJellyfinTools } from "./jellyfin.ts"
import { buildMediaFramesTool } from "./media-frames.ts"
import { buildMediaTools } from "./media.ts"
import { buildProgressTool, type StatusComment } from "./progress.ts"
import { buildSabnzbdTools } from "./sabnzbd.ts"
import { buildSeerrTools } from "./seerr.ts"

export type { StatusComment } from "./progress.ts"

export interface SessionFileRef {
  current: string | undefined
}

export type MediaScope = "movie" | "tv" | undefined

export interface IssueToolDeps {
  modelInput?: readonly ("text" | "image")[]
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
 * Issue tools: the live public status comment, the case file, one request
 * tool per service (reads and pipeline writes, admin routes refused), gated
 * deletion tools, media probing, and run-history search.
 * The known media type grants only its Arr. An unknown type grants neither.
 */
export function buildIssueTools(deps: IssueToolDeps): HostTool[] {
  const config = deps.config
  const ctx = deps.ctx
  const tools: HostTool[] = [
    buildProgressTool(
      deps.seerr,
      deps.issueId,
      deps.anchor,
      config.language,
      deps.status,
    ),
    buildCaseFileTool(deps.casefile),
    ...buildSeerrTools(config.seerr, ctx),
  ]
  if (config.sonarr && deps.mediaScope === "tv") {
    tools.push(
      ...buildSonarrTools(config.sonarr, ctx, config.media !== undefined),
    )
  }
  if (config.radarr && deps.mediaScope === "movie") {
    tools.push(...buildRadarrTools(config.radarr, ctx))
  }
  if (config.jellyfin) tools.push(...buildJellyfinTools(config.jellyfin, ctx))
  if (config.sabnzbd) tools.push(...buildSabnzbdTools(config.sabnzbd, ctx))
  if (config.media) tools.push(...buildMediaTools(config.media, ctx))
  if (config.media?.roots.length && deps.modelInput?.includes("image")) {
    tools.push(buildMediaFramesTool(config.media, ctx))
  }
  tools.push(buildHistoryTool(config.dataDir, deps.sessionFileRef))
  return tools
}
