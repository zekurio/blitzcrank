import { Cause, Effect, Exit } from "effect"

import {
  failureMessage,
  toolFail,
  WriteOutcomeUnknown,
  type ToolFailure,
} from "./errors.ts"
import { errorResult, type ToolResult } from "./results.ts"

type ToolSchema = { type: "object"; [key: string]: unknown }

export interface ServerTool {
  name: string
  description: string
  inputSchema: ToolSchema
  /** The host decides replay safety from `readOnlyHint` alone. */
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean }
  execute: (
    args: unknown,
    signal: AbortSignal,
  ) => Effect.Effect<ToolResult, ToolFailure | WriteOutcomeUnknown>
}

type ToolOutcome =
  | { status: "ok" | "error"; result: ToolResult }
  | { status: "unknown"; message: string }

export async function runTool(
  tool: ServerTool,
  args: unknown,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  const exit = await Effect.runPromiseExit(
    tool.execute(args, signal),
    // A write is never bound to its request. A client that disconnects must
    // not cut it between two requests or before its read-back.
    tool.annotations.readOnlyHint ? { signal } : {},
  )
  if (Exit.isSuccess(exit)) return { status: "ok", result: exit.value }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    return {
      status: "error",
      result: errorResult(`${tool.name} was cancelled`),
    }
  }
  const error = Cause.squash(exit.cause)
  if (error instanceof WriteOutcomeUnknown) {
    return { status: "unknown", message: error.message }
  }
  return { status: "error", result: errorResult(failureMessage(error)) }
}

/** The service a table belongs to: its tool-name prefix and what it is. */
export interface Service {
  name: string
  label: string
}

export function withDeadline(name: string, durationMs: number) {
  return <A>(
    effect: Effect.Effect<A, ToolFailure>,
  ): Effect.Effect<A, ToolFailure> =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: durationMs,
        orElse: () =>
          toolFail(`${name} did not finish within ${durationMs} ms`),
      }),
    )
}

export function sentence(description: string): string {
  return /[.!?]$/.test(description) ? description : `${description}.`
}
