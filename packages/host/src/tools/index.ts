import type { ToolRegistration } from "@earendil-works/pi-durable"

import type { CaseFile } from "../casefile.ts"
import type { Config } from "../config.ts"
import type { McpConnection } from "../mcp/client.ts"
import { buildMcpTools } from "../mcp/tools.ts"
import type { SeerrClient } from "../services/seerr.ts"
import { buildCaseFileTool } from "./casefile.ts"
import { buildCodemodeTool } from "./codemode.ts"
import { buildHistoryTool } from "./history.ts"
import { buildProgressTool, type StatusComment } from "./progress.ts"

export type { StatusComment } from "./progress.ts"

export interface SessionFileRef {
  current: string | undefined
}

export type MediaScope = "movie" | "tv" | undefined

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
  /** Known media type; grants one Arr, or neither when unknown. */
  mediaScope: MediaScope
  /** Shared handle to the run's live status comment (posted, then edited). */
  status: StatusComment
  /** This issue's memory; the agent rewrites its summary, the host persists it. */
  casefile: CaseFile
}

export interface IssueTools {
  /** Durable tools the model calls directly. */
  tools: ToolRegistration[]
  /** Read-only tool names reachable only inside codemode scripts. */
  scriptTools: string[]
}

/**
 * Issue tools: the live public status comment, the case file, run-history
 * search, the MCP server's write tools, and one codemode tool whose scripts
 * call the server's read-only tools. The host no longer knows which services
 * exist; the server's tool list decides, narrowed to the run's media type.
 */
export function buildIssueTools(deps: IssueToolDeps): IssueTools {
  const config = deps.config
  const mcp = buildMcpTools(deps.mcp, deps.mediaScope)
  // Frames are worthless to a model that cannot view them.
  const readOnly = mcp.readOnly.filter(
    (tool) =>
      tool.name !== "media_frames" || deps.modelInput?.includes("image"),
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
      ...mcp.direct,
      // Without a read-only tool a script could do nothing at all.
      ...(readOnly.length > 0
        ? [buildCodemodeTool(readOnly, deps.modelInput)]
        : []),
    ],
    scriptTools: readOnly.map((tool) => tool.name),
  }
}
