import type { ToolRegistration } from "@earendil-works/pi-durable"

import type { Channel } from "../gateway.ts"
import type { McpConnection } from "../mcp/client.ts"
import { buildMcpTools } from "../mcp/tools.ts"
import { buildHistoryTool } from "./history.ts"
import { buildCloseTool, type RunIntents } from "./outcome.ts"
import { buildToolSearchTool } from "./search.ts"

export interface SessionFileRef {
  current: string | undefined
}

export interface RunToolDeps {
  modelInput?: readonly ("text" | "image")[]
  /** This run's MCP connection; every service read and write goes through it. */
  mcp: McpConnection
  /** Where the gateway's threads keep their conversations. */
  history: string
  sessionFileRef: SessionFileRef
  /** What the run asks of the host once its reply is out. */
  intents: RunIntents
  /** Set when the thread's gateway lets the agent close it. */
  close: Channel["close"]
}

export interface RunTools {
  /** Every Durable tool of the run, the loadable ones included. */
  tools: ToolRegistration[]
  /** Tools the model has to load with `tool_search` before it can call them. */
  loadable: string[]
}

/**
 * A run's tools: history search, the gateway's close request, and every tool
 * the MCP server lists. None of them knows which gateway the thread came
 * from, and the host does not know which services exist; the server's tool
 * list decides. Server tools start out unloaded so their schemas stay out of
 * the prompt until `tool_search` loads the ones a run needs.
 */
export function buildRunTools(deps: RunToolDeps): RunTools {
  const viewsImages = deps.modelInput?.includes("image") === true
  const mcp = buildMcpTools(deps.mcp, viewsImages).filter(
    // Frames are worthless to a model that cannot view them.
    (tool) => tool.name !== "media_frames" || viewsImages,
  )
  return {
    tools: [
      buildHistoryTool(deps.history, deps.sessionFileRef),
      ...(deps.close ? [buildCloseTool(deps.close, deps.intents)] : []),
      ...mcp,
      // Without a server tool there is nothing to load.
      ...(mcp.length > 0 ? [buildToolSearchTool(mcp)] : []),
    ],
    loadable: mcp.map((tool) => tool.name),
  }
}
