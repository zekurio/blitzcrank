import { Cause, Data, Effect, Exit } from "effect"
import { Type, type Static, type TObject } from "typebox"
import { Check, Errors } from "typebox/value"

import {
  HttpError,
  HttpRequestError,
  HttpTimeoutError,
  type JsonRequestError,
  type JsonValue,
} from "./http.ts"
import { isJsonObject, type JsonObject } from "./json.ts"

export const MAX_RESULT_CHARS = 30_000
export const MAX_LIST_ITEMS = 100
const MAX_OUTCOME_PART_CHARS = 12_000

/**
 * The host gives one tool call 180 s and treats its own timeout on a write as
 * an unknown outcome, so every call here has to answer first: a read within
 * its deadline, a write within the sum of its three phases.
 */
const READ_DEADLINE_MS = 150_000
const RESOLVE_TIMEOUT_MS = 45_000
const WRITE_TIMEOUT_MS = 90_000
const VERIFY_TIMEOUT_MS = 30_000

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

export function toText(data: JsonValue | undefined): string {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2)
  if (text === undefined) return "null"
  if (text.length <= MAX_RESULT_CHARS) return text
  return `${text.slice(0, MAX_RESULT_CHARS)}\n... [truncated ${text.length - MAX_RESULT_CHARS} chars]`
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }

export interface ToolResult {
  content: ContentBlock[]
  isError?: true
}

export function jsonResult(value: JsonObject): ToolResult {
  return { content: [{ type: "text", text: toText(value) }] }
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: toText(message) }], isError: true }
}

/** A capped page of a list, saying how many entries exist beyond it. */
export function listResult(
  items: JsonObject[],
  opts: { total?: number | undefined; offset?: number | undefined } = {},
): JsonObject {
  const offset = opts.offset ?? 0
  const listed = items.slice(offset, offset + MAX_LIST_ITEMS)
  const total = opts.total ?? items.length
  return {
    total,
    listed: listed.length,
    ...(offset > 0 ? { offset } : {}),
    ...(offset + listed.length < total ? { truncated: true } : {}),
    items: listed,
  }
}

export type ToolSchema = { type: "object"; [key: string]: unknown }

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

export type ToolOutcome =
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

export interface ResourceSpec<P extends TObject> {
  description: string
  params: P
  run: (
    params: Static<P>,
    signal: AbortSignal,
  ) => Effect.Effect<JsonObject, ToolFailure>
}

export interface Resource {
  description: string
  params: TObject
  run: (
    params: JsonObject,
    signal: AbortSignal,
  ) => Effect.Effect<JsonObject, ToolFailure>
}

export function resource<P extends TObject>(spec: ResourceSpec<P>): Resource {
  return {
    description: spec.description,
    params: spec.params,
    // SAFETY: the tool checks the arguments against `params` first.
    run: (params, signal) => spec.run(params as Static<P>, signal),
  }
}

/** One read-only tool per table entry, named `<service>_<entry>`. */
export function defineReads(
  service: Service,
  resources: Record<string, Resource>,
): ServerTool[] {
  return Object.entries(resources).map(([entry, spec]) => {
    const name = `${service.name}_${entry}`
    const schema = strict(spec.params)
    return {
      name,
      description: `${service.label} read. ${sentence(spec.description)}`,
      inputSchema: { ...schema, type: "object" },
      annotations: { readOnlyHint: true },
      execute: (args, signal) =>
        checkParams(name, schema, args).pipe(
          Effect.flatMap((params) => spec.run(params, signal)),
          Effect.map(jsonResult),
          withDeadline(name, READ_DEADLINE_MS),
        ),
    }
  })
}

export type WriteEffect = { kind: string; target: string; detail?: string }

/** A write's target as live state has it, and what the write does to it. */
export interface Resolved<S> {
  state: S
  summary: string
  effects: WriteEffect[]
  warnings: string[]
}

export interface ActionSpec<P extends TObject, S> {
  description: string
  params: P
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

export interface Action {
  description: string
  params: TObject
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
          const resolved = yield* spec
            .resolve(params, signal)
            .pipe(withDeadline(name, RESOLVE_TIMEOUT_MS))
          return yield* writeAndVerify(name, spec, params, resolved)
        }),
    }
  })
}

function writeAndVerify(
  name: string,
  spec: Action,
  params: JsonObject,
  resolved: Resolved<unknown>,
): Effect.Effect<ToolResult, ToolError | WriteOutcomeUnknown> {
  return Effect.gen(function* () {
    const written = yield* spec.write(params, resolved.state).pipe(
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

function bounded(value: JsonValue): JsonValue {
  const text = JSON.stringify(value)
  if (text.length <= MAX_OUTCOME_PART_CHARS) return value
  return `${text.slice(0, MAX_OUTCOME_PART_CHARS)}... [truncated ${text.length - MAX_OUTCOME_PART_CHARS} chars]`
}

function withDeadline(name: string, durationMs: number) {
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

/** A table entry's own schema, closed so a misspelt parameter is an error. */
function strict(params: TObject): TObject {
  return Type.Object(params.properties, { additionalProperties: false })
}

function sentence(description: string): string {
  return /[.!?]$/.test(description) ? description : `${description}.`
}

function checkParams(
  tool: string,
  schema: TObject,
  args: unknown,
): Effect.Effect<JsonObject, ToolError> {
  // SAFETY: the arguments arrived as JSON and passed the tool's schema.
  return checkArgs(tool, schema, args).pipe(
    Effect.map((params) => params as JsonObject),
  )
}

export function checkArgs<P extends TObject>(
  tool: string,
  schema: P,
  args: unknown,
): Effect.Effect<Static<P>, ToolError> {
  if (Check(schema, args)) return Effect.succeed(args)
  return toolFail(
    `invalid arguments for ${tool}: ${describeErrors(schema, args)}`,
  )
}

const MAX_REPORTED_ERRORS = 6

function describeErrors(schema: TObject, value: unknown): string {
  const lines = Errors(schema, value).flatMap((error) => {
    const path = error.instancePath.replace(/^\//, "").replaceAll("/", ".")
    const at = path ? `${path}: ` : ""
    if (error.keyword === "boolean" || error.schemaPath.includes("/anyOf/")) {
      return []
    }
    if (error.keyword === "additionalProperties") {
      return [
        `${at}unknown parameter ${error.params.additionalProperties.join(", ")}`,
      ]
    }
    if (error.keyword === "required") {
      return [
        `${at}missing required parameter ${error.params.requiredProperties.join(", ")}`,
      ]
    }
    if (error.keyword === "enum") {
      return [
        `${at}must be one of ${error.params.allowedValues.map(String).join(", ")}`,
      ]
    }
    return [`${at || "arguments: "}${error.message}`]
  })
  const unique = [...new Set(lines)]
  if (unique.length === 0) return "arguments do not match the schema"
  return unique.slice(0, MAX_REPORTED_ERRORS).join("; ")
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failureMessage(error: unknown): string {
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

const PLACEHOLDER_ORIGIN = "http://service.invalid"

export function rawPath(
  path: string,
  prefix: string,
): Effect.Effect<string, ToolError> {
  return toolCheck(() => {
    const resolved = URL.canParse(path.slice(1), `${PLACEHOLDER_ORIGIN}/`)
      ? new URL(path.slice(1), `${PLACEHOLDER_ORIGIN}/`)
      : undefined
    if (
      !path.startsWith("/") ||
      resolved === undefined ||
      resolved.origin !== PLACEHOLDER_ORIGIN ||
      !(resolved.pathname + "/").startsWith(prefix.replace(/\/*$/, "/"))
    ) {
      throw new Error(
        `path must be a service-relative path below ${prefix}, with its query string and no host`,
      )
    }
    return resolved.pathname + resolved.search
  })
}

const SECRET_NAME =
  /api_?key|token|pass|secret|credential|cookie|webhook|private/i

export function rawResult(
  response: JsonValue | undefined,
  secrets: readonly string[],
): JsonObject {
  return { response: redact(response ?? null, secrets) }
}

function redact(value: JsonValue, secrets: readonly string[]): JsonValue {
  if (typeof value === "string") {
    return secrets.reduce(
      (text, secret) => text.replaceAll(secret, "[redacted]"),
      value,
    )
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets))
  if (!isJsonObject(value)) return value
  const named = typeof value.name === "string" && SECRET_NAME.test(value.name)
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, member]) => {
      if (member === undefined) return []
      const secret = SECRET_NAME.test(key) || (named && key === "value")
      if (secret && typeof member === "string" && member !== "") {
        return [[key, "[redacted]"]]
      }
      return [[key, redact(member, secrets)]]
    }),
  )
}
