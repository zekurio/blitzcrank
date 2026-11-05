import { Effect } from "effect"
import { Type } from "typebox"

import { toolFail } from "./errors.ts"
import { checkArgs } from "./params.ts"
import { jsonResult } from "./results.ts"
import type { ServerTool } from "./tool.ts"

export const WRITE_PREVIEW = "write_preview"

/**
 * A read that runs one write's resolve phase and returns what that write
 * would touch and change, as live state has it. Nothing is written, so a
 * preview can never stand in for the write. The host reads one before it
 * reviews a destructive write.
 */
export function buildWritePreviewTool(
  tools: readonly ServerTool[],
): ServerTool | undefined {
  const writes = new Map(
    tools.flatMap((tool) =>
      tool.preview === undefined ? [] : [[tool.name, tool.preview] as const],
    ),
  )
  if (writes.size === 0) return undefined
  const params = Type.Object(
    {
      tool: Type.Enum([...writes.keys()], {
        description: "The write tool to preview",
      }),
      arguments: Type.Record(Type.String(), Type.Unknown(), {
        description: "The arguments that write would get",
      }),
    },
    { additionalProperties: false },
  )
  return {
    name: WRITE_PREVIEW,
    description:
      "Shows what one write would change, without writing: its target as live state has it, its effects, and " +
      "its warnings. It never writes, so the write itself is still needed.",
    inputSchema: { ...params, type: "object" },
    annotations: { readOnlyHint: true },
    execute: (args, signal) =>
      Effect.gen(function* () {
        const request = yield* checkArgs(WRITE_PREVIEW, params, args)
        const preview = writes.get(request.tool)
        if (preview === undefined)
          return yield* toolFail(`${request.tool} is not a write tool`)
        return jsonResult(yield* preview(request.arguments, signal))
      }),
  }
}
