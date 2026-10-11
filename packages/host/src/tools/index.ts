import type { ToolRegistration } from "@earendil-works/pi-durable"

import type { CaseFile } from "../casefile.ts"
import type { Config } from "../config.ts"
import type { McpConnection } from "../mcp/client.ts"
import { buildMcpTools } from "../mcp/tools.ts"
import type { SeerrClient } from "../services/seerr.ts"
import { buildCaseFileTool } from "./casefile.ts"
import { buildHistoryTool } from "./history.ts"
import { buildProgressTool, type StatusComment } from "./progress.ts"
import { buildToolSearchTool } from "./search.ts"

export type { StatusComment } from "./progress.ts"

export interface SessionFileRef {
  current: string | undefined
}

export interface IssueToolDeps {
  modelInput?: readonly ("text" | "image")[]
  config: Config
  seerr: SeerrClient
  /** This run's MCP connection; every service read and write goes through it. */
  mcp: McpConnection
  issueId: string | number
  /** Model identity footer appended to public comments, e.g. "[blitzcrank w/ ...]". */
  anchor: string
  sessionFileRef: SessionFileRef
  /** Shared handle to the run's live status comment (posted, then edited). */
  status: StatusComment
  /** This issue's memory; the agent rewrites its summary, the host persists it. */
  casefile: CaseFile
}

export interface IssueTools {
  /** Every Durable tool of the run, the loadable ones included. */
  tools: ToolRegistration[]
  /** Tools the model has to load with `tool_search` before it can call them. */
  loadable: string[]
}

/**
 * Issue tools: the live public status comment, the case file, run-history
 * search, and every tool the MCP server lists. The host does not know which
 * services exist; the server's tool list decides. Server tools start out
 * unloaded so their schemas stay out of the prompt until `tool_search` loads
 * the ones a run needs.
 */
export function buildIssueTools(deps: IssueToolDeps): IssueTools {
  const config = deps.config
  const viewsImages = deps.modelInput?.includes("image") === true
  const mcp = buildMcpTools(deps.mcp, viewsImages).filter(
    // Frames are worthless to a model that cannot view them.
    (tool) => tool.name !== "media_frames" || viewsImages,
  )
  return {
    tools: [
      buildProgressTool(
        deps.seerr,
        deps.issueId,
        deps.anchor,
        config.language,
        deps.status,
      ),
      buildCaseFileTool(deps.casefile),
      buildHistoryTool(config.dataDir, deps.sessionFileRef),
      ...mcp,
      // Without a server tool there is nothing to load.
      ...(mcp.length > 0 ? [buildToolSearchTool(mcp)] : []),
    ],
    loadable: mcp.map((tool) => tool.name),
  }
}
