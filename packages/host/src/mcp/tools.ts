import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable"
import {
  toLlmContent,
  type CallToolResult,
  type LlmContent,
  type Tool,
} from "@earendil-works/pi-mcp"
import { Type } from "typebox"

import { toText } from "../tools/common.ts"
import type { McpConnection } from "./client.ts"

/** What one result may show the model, whatever the server sent. */
const MAX_IMAGES = 6

/**
 * One Durable tool per server tool. Sorted by name so the Durable policy
 * fingerprint does not depend on the order the server lists them in.
 */
export function buildMcpTools(
  connection: McpConnection,
  viewsImages: boolean,
): ToolRegistration[] {
  return connection.tools
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((tool) => mcpTool(connection, tool, viewsImages))
}

/**
 * `readOnlyHint` alone decides replay. A read may rerun after an
 * interruption. Anything else keeps the unsafe default, so a write that was
 * interrupted, or whose call was rejected, stops the run for review.
 */
function mcpTool(
  connection: McpConnection,
  tool: Tool,
  viewsImages: boolean,
): ToolRegistration {
  const readOnly = tool.annotations?.readOnlyHint === true
  return defineTool({
    name: tool.name,
    description: tool.description ?? tool.name,
    ...(readOnly ? { replay: "safe" as const } : {}),
    // Providers require an object schema, and some reject one without
    // `properties`.
    parameters: Type.Unsafe<Record<string, unknown>>({
      ...tool.inputSchema,
      type: "object",
      properties: tool.inputSchema.properties ?? {},
    }),
    async execute(args, _api, context) {
      const result = await connection
        .callTool(tool.name, args, context.abortSignal)
        .then(undefined, (cause: unknown) => {
          // The journal is the only place the reason for a review stop lands.
          if (!readOnly)
            console.error(`[mcp] ${tool.name} has no known outcome:`, cause)
          throw cause
        })
      return {
        content: modelContent(result, viewsImages),
        isError: result.isError === true,
      }
    },
  })
}

function modelContent(
  result: CallToolResult,
  viewsImages: boolean,
): LlmContent[] {
  const blocks = toLlmContent(result)
  const images = blocks.filter((block) => block.type === "image")
  const shown = new Set(images.slice(0, viewsImages ? MAX_IMAGES : 0))
  const content = blocks.flatMap((block): LlmContent[] => {
    if (block.type === "text") return [{ ...block, text: toText(block.text) }]
    return shown.has(block) ? [block] : []
  })
  if (images.length === shown.size) return content
  return [
    ...content,
    {
      type: "text",
      text: viewsImages
        ? `[${images.length - shown.size} more images omitted: at most ${MAX_IMAGES} come back per call]`
        : `[${images.length} images omitted: this model cannot view images]`,
    },
  ]
}
