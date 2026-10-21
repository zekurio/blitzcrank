import { Data, Effect } from "effect"

import { HttpRequestError, type JsonRequestError } from "../http.ts"

export class ToolError extends Data.TaggedError("ToolError")<{
  message: string
}> {}

/**
 * A write whose request went out and whose result never came back. It may or
 * may not have taken effect, so it must not be reported as a plain failure.
 */
export class WriteOutcomeUnknown extends Data.TaggedError(
  "WriteOutcomeUnknown",
)<{
  message: string
}> {}

export type ToolFailure = ToolError | JsonRequestError

export function toolFail(message: string): Effect.Effect<never, ToolError> {
  return Effect.fail(new ToolError({ message }))
}

/** Keeps a synchronous guard that throws in the typed failure channel. */
export function toolCheck<A>(check: () => A): Effect.Effect<A, ToolError> {
  return Effect.try({
    try: check,
    catch: (error) => new ToolError({ message: messageOf(error) }),
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function failureMessage(error: unknown): string {
  if (!(error instanceof HttpRequestError)) return messageOf(error)
  const cause = error.cause instanceof Error ? error.cause.cause : undefined
  const detail = isPlainObject(cause)
    ? [cause.code, cause.message].filter(
        (part) => typeof part === "string" && part !== "",
      )
    : []
  if (detail.length === 0) return `service request failed: ${error.message}`
  return `service request failed: ${error.message} (${[...new Set(detail)].join(": ")})`
}
