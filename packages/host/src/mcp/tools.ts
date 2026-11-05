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
 * The argument the host adds to every write it reviews, for the review
 * alone. The server never sees it.
 */
export const REASON_PARAM = "reason"

/**
 * Whether the host reviews a server tool's calls before they run: every
 * write unless the server marks it `destructiveHint: false`, as MCP defaults
 * a write to destructive.
 */
export function reviewsTool(tool: Tool): boolean {
  return (
    tool.annotations?.readOnlyHint !== true &&
    tool.annotations?.destructiveHint !== false
  )
}

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
  const reviewed = reviewsTool(tool)
  // Every write takes a reason, so one given to a write the host does not
  // review is dropped instead of failing the call. Only reviewed writes
  // require it.
  const reasoned = !readOnly
  const schema = tool.inputSchema
  const properties = isRecord(schema.properties) ? schema.properties : {}
  if (reasoned && REASON_PARAM in properties)
    throw new Error(
      `${tool.name} has a ${REASON_PARAM} parameter, which the host's write review needs for itself`,
    )
  return defineTool({
    name: tool.name,
    description: tool.description ?? tool.name,
    ...(readOnly ? { replay: "safe" as const } : {}),
    // Providers require an object schema, and some reject one without
    // `properties`.
    parameters: Type.Unsafe<Record<string, unknown>>({
      ...schema,
      type: "object",
      properties: reasoned
        ? {
            ...properties,
            [REASON_PARAM]: {
              type: "string",
              minLength: 1,
              maxLength: 600,
              description:
                "One sentence for the host's write review: what the evidence shows and what this write fixes. The service never sees it.",
            },
          }
        : properties,
      ...(reviewed
        ? {
            required: [
              ...(Array.isArray(schema.required) ? schema.required : []),
              REASON_PARAM,
            ],
          }
        : {}),
    }),
    async execute(args, _api, context) {
      const result = await connection.callTool(
        tool.name,
        reasoned
          ? Object.fromEntries(
              Object.entries(args).filter(([key]) => key !== REASON_PARAM),
            )
          : args,
        context.abortSignal,
      )
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
