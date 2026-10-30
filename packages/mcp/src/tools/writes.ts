import { Cause, Effect } from "effect"
import type { Static, TObject } from "typebox"

import { HttpError, HttpTimeoutError, type JsonValue } from "../http.ts"
import type { JsonObject } from "../json.ts"
import {
  failureMessage,
  toolCheck,
  ToolError,
  WriteOutcomeUnknown,
  type ToolFailure,
} from "./errors.ts"
import { dropKeptReads } from "./kept-reads.ts"
import { checkParams, strict } from "./params.ts"
import { bounded, jsonResult, type ToolResult } from "./results.ts"
import {
  sentence,
  withDeadline,
  type ServerTool,
  type Service,
} from "./tool.ts"

/**
 * The host gives one tool call 180 s and treats its own timeout on a write as
 * an unknown outcome, so a write has to answer within the sum of its three
 * phases first.
 */
const RESOLVE_TIMEOUT_MS = 45_000
const WRITE_TIMEOUT_MS = 90_000
const VERIFY_TIMEOUT_MS = 30_000

// One configured instance per service. Only held keys are retained, and the
// lock covers this process's calls, not external or still-pending writes.
const activeWriteKeys = new Set<string>()

export type WriteEffect = { kind: string; target: string; detail?: string }

/** A write's target as live state has it, and what the write does to it. */
export interface Resolved<S> {
  state: S
  summary: string
  effects: WriteEffect[]
  warnings: string[]
}

interface ActionSpec<P extends TObject, S> {
  description: string
  params: P
  /** Per-service record key, derived from validated params without I/O. */
  lock?: (params: Static<P>) => string
  /** Reads the target. A target that does not exist fails here, unwritten. */
  resolve: (
    params: Static<P>,
    signal: AbortSignal | undefined,
  ) => Effect.Effect<Resolved<S>, ToolFailure>
  write: (
    params: Static<P>,
    state: S,
  ) => Effect.Effect<JsonValue | undefined, ToolFailure>
  /** Reads the result back. Its failure never hides a completed write. */
  verify: (
    params: Static<P>,
    result: JsonValue,
    state: S,
  ) => Effect.Effect<JsonValue, ToolFailure>
}

interface Action {
  description: string
  params: TObject
  lock: (params: JsonObject) => string | undefined
  resolve: (
    params: JsonObject,
    signal: AbortSignal | undefined,
  ) => Effect.Effect<Resolved<unknown>, ToolFailure>
  write: (
    params: JsonObject,
    state: unknown,
  ) => Effect.Effect<JsonValue | undefined, ToolFailure>
  verify: (
    params: JsonObject,
    result: JsonValue,
    state: unknown,
  ) => Effect.Effect<JsonValue, ToolFailure>
}

export function action<P extends TObject, S>(spec: ActionSpec<P, S>): Action {
  // SAFETY: the tool checks the arguments against `params` first, and the
  // state handed back is always the one this action's own `resolve` made.
  return {
    description: spec.description,
    params: spec.params,
    lock: (params) => spec.lock?.(params as Static<P>),
    resolve: (params, signal) => spec.resolve(params as Static<P>, signal),
    write: (params, state) => spec.write(params as Static<P>, state as S),
    verify: (params, result, state) =>
      spec.verify(params as Static<P>, result, state as S),
  }
}

/**
 * One write tool per table entry, named `<service>_<entry>`. A call resolves
 * its target against live state, writes, and reads the result back.
 */
export function defineWrites(
  service: Service,
  actions: Record<string, Action>,
): ServerTool[] {
  return Object.entries(actions).map(([entry, spec]) => {
    const name = `${service.name}_${entry}`
    const schema = strict(spec.params)
    return {
      name,
      description:
        `${service.label} write. ${sentence(spec.description)} ` +
        "Returns what it changed, its warnings, and a read-back.",
      inputSchema: { ...schema, type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: true },
      execute: (args, signal) =>
        Effect.gen(function* () {
          const params = yield* checkParams(name, schema, args)
          const write = Effect.gen(function* () {
            const resolved = yield* spec
              .resolve(params, signal)
              .pipe(withDeadline(name, RESOLVE_TIMEOUT_MS))
            return yield* writeAndVerify(name, spec, params, resolved)
          })
          const key = spec.lock(params)
          return yield* key === undefined
            ? write
            : withWriteLock(name, `${service.name}:${key}`, write)
        }),
    }
  })
}

function withWriteLock<A, E, R>(
  name: string,
  key: string,
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    toolCheck(() => {
      // No yield between checking and taking the key. Busy callers never
      // queue or spend any of the tool's deadline waiting for another write.
      if (activeWriteKeys.has(key)) {
        throw new Error(
          `${name}: resource ${key} is busy; nothing was written. Read the current state before another attempt.`,
        )
      }
      activeWriteKeys.add(key)
    }),
    () => effect,
    () => Effect.sync(() => activeWriteKeys.delete(key)),
  )
}

function writeAndVerify(
  name: string,
  spec: Action,
  params: JsonObject,
  resolved: Resolved<unknown>,
): Effect.Effect<ToolResult, ToolError | WriteOutcomeUnknown> {
  return Effect.gen(function* () {
    dropKeptReads()
    const written = yield* spec.write(params, resolved.state).pipe(
      Effect.ensuring(Effect.sync(dropKeptReads)),
      Effect.timeoutOrElse({
        duration: WRITE_TIMEOUT_MS,
        orElse: () =>
          Effect.fail(new HttpTimeoutError({ timeoutMs: WRITE_TIMEOUT_MS })),
      }),
      Effect.catchCause(
        (cause): Effect.Effect<never, ToolError | WriteOutcomeUnknown> => {
          const error = Cause.squash(cause)
          const reason = failureMessage(error)
          return Effect.fail(
            serviceAnswered(error)
              ? new ToolError({
                  message: `${name} was rejected: ${reason}. Read the current state before another attempt.`,
                })
              : new WriteOutcomeUnknown({
                  message: `${name} sent its write and never got the result: ${reason}. It may or may not have taken effect. Operator review is required before another write.`,
                }),
          )
        },
      ),
    )
    const result = written ?? { ok: true }
    const readBack = yield* Effect.suspend(() =>
      spec.verify(params, result, resolved.state),
    ).pipe(
      Effect.timeoutOrElse({
        duration: VERIFY_TIMEOUT_MS,
        orElse: () =>
          Effect.fail(new HttpTimeoutError({ timeoutMs: VERIFY_TIMEOUT_MS })),
      }),
      Effect.map(
        (verification): JsonObject => ({
          verification: bounded(verification),
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.succeed<JsonObject>({
          verificationError: failureMessage(Cause.squash(cause)),
        }),
      ),
    )
    return jsonResult({
      summary: resolved.summary,
      effects: resolved.effects,
      warnings: resolved.warnings,
      result: bounded(result),
      ...readBack,
    })
  })
}

/**
 * Whether a failed write is a definite answer. A status the service chose
 * and a guard in this server are; a timeout, a dropped connection, and a
 * gateway's 502 or 504 are not.
 */
function serviceAnswered(error: unknown): boolean {
  if (error instanceof ToolError) return true
  return (
    error instanceof HttpError && error.status !== 502 && error.status !== 504
  )
}
