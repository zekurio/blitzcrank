import type {
  CodemodeJsonSchema,
  CodemodeTool,
} from "@earendil-works/pi-codemode"
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable"
import {
  toLlmContent,
  type CallToolResult,
  type Tool,
} from "@earendil-works/pi-mcp"
import { Type } from "typebox"

import { toText } from "../tools/common.ts"
import type { MediaScope } from "../tools/index.ts"
import type { McpConnection } from "./client.ts"

export interface McpRunTools {
  /** Write tools: the model calls each directly, one Durable task per call. */
  direct: ToolRegistration[]
  /** Read-only tools: reachable only from codemode scripts. */
  readOnly: CodemodeTool[]
}

/** What a script receives from a tool that declares no output schema. */
const LOOSE_OBJECT: CodemodeJsonSchema = {
  type: "object",
  additionalProperties: true,
}

/**
 * Splits the server's tools for one run. `readOnlyHint` alone decides
 * exposure: a read-only tool never becomes a Durable tool, and anything else
 * never reaches a script. Sorted by name so the Durable policy fingerprint
 * does not depend on the order the server lists them in.
 */
export function buildMcpTools(
  connection: McpConnection,
  mediaScope: MediaScope,
): McpRunTools {
  const tools = connection.tools
    .filter((tool) => inScope(tool.name, mediaScope))
    .toSorted((a, b) => a.name.localeCompare(b.name))
  return {
    direct: tools
      .filter((tool) => tool.annotations?.readOnlyHint !== true)
      .map((tool) => directTool(connection, tool)),
    readOnly: tools
      .filter((tool) => tool.annotations?.readOnlyHint === true)
      .map((tool) => scriptTool(connection, tool)),
  }
}

/** The known media type grants its own Arr. An unknown type grants neither. */
function inScope(name: string, mediaScope: MediaScope): boolean {
  if (name.startsWith("sonarr_")) return mediaScope === "tv"
  if (name.startsWith("radarr_")) return mediaScope === "movie"
  return true
}

/** No `replay`: a write interrupted mid-call must stop for review. */
function directTool(connection: McpConnection, tool: Tool): ToolRegistration {
  return defineTool({
    name: tool.name,
    description: tool.description ?? tool.name,
    // Providers require an object schema, and some reject one without
    // `properties`.
    parameters: Type.Unsafe<Record<string, unknown>>({
      ...tool.inputSchema,
      type: "object",
      properties: tool.inputSchema.properties ?? {},
    }),
    async execute(args, _api, context) {
      const result = await connection.callTool(
        tool.name,
        args,
        context.abortSignal,
      )
      // The MCP server may answer after losing the service's write response.
      // Throw so Durable leaves the unsafe intent unresolved and stops the run.
      if (result.structuredContent?.writeOutcome === "unknown") {
        throw new Error(resultText(result) || `${tool.name} outcome is unknown`)
      }
      // Validation, stale plans and explicit service rejections are known
      // failures and may be checkpointed without blocking continuation.
      return {
        content: toLlmContent(result).map((block) =>
          block.type === "text"
            ? { ...block, text: toText(block.text) }
            : block,
        ),
        isError: result.isError === true,
      }
    },
  })
}

function scriptTool(connection: McpConnection, tool: Tool): CodemodeTool {
  return {
    name: tool.name,
    ...(tool.description !== undefined
      ? { description: tool.description }
      : {}),
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema ?? LOOSE_OBJECT,
    async execute(args, context) {
      if (args === null || typeof args !== "object" || Array.isArray(args))
        throw new Error(`${tool.name} takes one object argument`)
      const result = await connection.callTool(
        tool.name,
        // SAFETY: a non-null, non-array object after codemode's JSON round trip.
        args as Record<string, unknown>,
        context.signal,
      )
      if (result.isError === true)
        throw new Error(resultText(result) || `${tool.name} failed`)
      if (result.structuredContent !== undefined)
        return result.structuredContent
      // Frames have no structured form. The script gets the content blocks
      // and passes each image block to `image()`.
      if (result.content.some((block) => block.type === "image"))
        return result.content
      return resultText(result)
    },
  }
}

function resultText(result: CallToolResult): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
}
