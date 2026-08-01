import path from "node:path"

import type { ToolDefinition } from "@earendil-works/pi-coding-agent"

import type { CaseFile } from "../casefile.js"
import type { Config } from "../config.js"
import type { SeerrClient } from "../services/seerr.js"
import { buildAnvilTools } from "./anvil.js"
import { buildRadarrTools, buildSonarrTools } from "./arr.js"
import { buildCaseFileTool } from "./casefile.js"
import type { RunContext } from "./context.js"
import { buildHistoryTool } from "./history.js"
import { buildMediaTools } from "./media.js"
import {
  buildJellyfinTools,
  buildProgressTool,
  buildSabnzbdTools,
  buildSeerrTools,
  type StatusComment,
} from "./services.js"

export type { StatusComment } from "./services.js"
import { buildWebTools } from "./web.js"

export interface SessionFileRef {
  current: string | undefined
}

/**
 * Service tool set shared by issue runs and automations: GET-only reads,
 * typed evidence-gated mutations, anvil correlation, run-history search.
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
  if (config.anvil) tools.push(...buildAnvilTools(config.anvil, ctx))
  if (config.media) tools.push(...buildMediaTools(config.media, ctx))
  tools.push(
    buildHistoryTool(path.join(config.dataDir, "sessions"), sessionFileRef),
  )
  return tools
}

/** The Anvil surface minus `anvil_retry_job`, enumerated deliberately. */
const ANVIL_READS = new Set([
  "anvil_status",
  "anvil_job_list",
  "anvil_job_show",
  "anvil_job_lookup",
])

/**
 * True for tools that cannot change service state. Automations register these
 * unconditionally and subtract everything else from their declared
 * capabilities, so this predicate is exactly as tight as that allowlist.
 *
 * The Anvil reads are listed one by one rather than matched on the `anvil_`
 * prefix. That prefix predated `anvil_retry_job` and went on matching after it
 * landed, which handed every automation a requeue tool none of them had
 * declared, outside any capability mapping. An enumeration fails in the safe
 * direction: a new read tool is withheld until someone lists it here, where a
 * new mutation tool used to be granted silently.
 */
export function isReadTool(name: string): boolean {
  return (
    name.endsWith("_request") ||
    ANVIL_READS.has(name) ||
    name === "media_probe" ||
    name === "thread_history_search"
  )
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
    // Issue runs only: availability/context lookups. Automations stay mechanical.
    ...(deps.config.firecrawl ? buildWebTools(deps.config.firecrawl) : []),
  ]
}
