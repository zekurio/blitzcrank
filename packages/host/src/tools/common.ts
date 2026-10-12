import { Data, Effect } from "effect"

import type { JsonValue } from "../services/http.ts"

export const MAX_RESULT_CHARS = 30_000

export function toText(data: JsonValue): string {
  const text = isString(data) ? data : JSON.stringify(data)
  if (text == null) return "null"
  if (text.length <= MAX_RESULT_CHARS) return text
  return `${text.slice(0, MAX_RESULT_CHARS)}\n... [truncated ${text.length - MAX_RESULT_CHARS} chars — narrow your query]`
}

export type ToolResultDetails = Record<string, string | number | boolean | null>

export function textResult(data: JsonValue, details: ToolResultDetails = {}) {
  return { content: [{ type: "text" as const, text: toText(data) }], details }
}

export class ToolError extends Data.TaggedError("ToolError")<{
  message: string
}> {}

/** Keep existing synchronous tool guards in the typed failure channel. */
export function toolCheck<A>(check: () => A): Effect.Effect<A, ToolError> {
  return Effect.try({
    try: check,
    catch: (error) =>
      new ToolError({
        message: error instanceof Error ? error.message : String(error),
      }),
  })
}

function isString<Value>(value: Value): value is Value & string {
  return typeof value === "string"
}
