import { Cause, Data, Effect, Exit } from "effect"
import { Type, type Static, type TObject } from "typebox"
import { Check, Errors } from "typebox/value"

import {
  HttpRequestError,
  HttpTimeoutError,
  type JsonRequestError,
  type JsonValue,
} from "./http.ts"
import { isJsonObject, type JsonObject } from "./json.ts"
import {
  fingerprintDiff,
  type ApplyAttempt,
  type ApplyOutcome,
  type PlanStore,
  type StoredPlan,
} from "./plans.ts"

export const MAX_RESULT_CHARS = 30_000
export const MAX_LIST_ITEMS = 100

/**
 * The host gives one tool call 180 s and treats its own timeout as an unknown
 * outcome, so every call here has to answer first.
 */
const CALL_DEADLINE_MS = 150_000
/** Apply phases. With the longest write (90 s) they still sum to 165 s. */
const REREAD_TIMEOUT_MS = 45_000
const VERIFY_TIMEOUT_MS = 30_000

export class ToolError extends Data.TaggedError("ToolError")<{
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
  /** Always an object: MCP rejects a bare array or scalar here. */
  structuredContent?: JsonObject
  isError?: true
}

/** Text for a model that reads it, the untruncated value for a script. */
export function jsonResult(value: JsonObject): ToolResult {
  return {
    content: [{ type: "text", text: toText(value) }],
    // Drops `undefined` members, which JSON-RPC could not carry anyway.
    structuredContent: JSON.parse(JSON.stringify(value)) as JsonObject,
  }
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: toText(message) }], isError: true }
}

/**
 * A capped list. `total` counts what the service has, `listed` what this
 * result carries, and `truncated` says the difference is not an absence.
 */
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

export interface ToolAnnotations {
  readOnlyHint: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export type ToolSchema = { type: "object"; [key: string]: unknown }

export interface ServerTool {
  name: string
  description: string
  inputSchema: ToolSchema
  outputSchema?: ToolSchema
  annotations: ToolAnnotations
  /** The resource or action a call names, for the request log. */
  label: (args: unknown) => string | undefined
  execute: (
    args: unknown,
    signal: AbortSignal,
  ) => Effect.Effect<ToolResult, ToolFailure>
}

/**
 * The boundary to the SDK callback: every failure, typed or thrown, becomes
 * an `isError` result, so only a malformed request is a protocol error.
 */
export async function runTool(
  tool: ServerTool,
  args: unknown,
  signal: AbortSignal,
): Promise<ToolResult> {
  const exit = await Effect.runPromiseExit(tool.execute(args, signal), {
    signal,
  })
  if (Exit.isSuccess(exit)) return exit.value
  if (Cause.hasInterruptsOnly(exit.cause)) {
    return errorResult(`${tool.name} was cancelled`)
  }
  return errorResult(failureMessage(Cause.squash(exit.cause)))
}

export interface ResourceSpec<P extends TObject> {
  /** Shown to the model on the discriminator; keep it to one line. */
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

/** One entry of a service's read table. */
export function resource<P extends TObject>(spec: ResourceSpec<P>): Resource {
  return {
    description: spec.description,
    params: spec.params,
    // SAFETY: `defineRead` checks the arguments against `params` first.
    run: (params, signal) => spec.run(params as Static<P>, signal),
  }
}

/** One `<service>_read` tool over a table of resources. */
export function defineRead(
  service: string,
  description: string,
  resources: Record<string, Resource>,
): ServerTool {
  const variants = variantSchemas("resource", resources)
  return {
    name: `${service}_read`,
    description: `${description} Resources: ${[...variants.keys()].join(", ")}.`,
    inputSchema: unionSchema("resource", variants),
    annotations: { readOnlyHint: true, openWorldHint: false },
    label: (args) => variantName("resource", variants, args),
    execute: (args, signal) =>
      Effect.gen(function* () {
        const call = yield* selectVariant(
          `${service}_read`,
          "resource",
          variants,
          args,
        )
        const spec = resources[call.name]
        if (!spec) return yield* toolFail(`unknown resource ${call.name}`)
        return jsonResult(yield* spec.run(call.params, signal))
      }).pipe(withDeadline(`${service}_read`)),
  }
}

export type PlanEffect = { kind: string; target: string; detail?: string }

export interface Planned<S> {
  /** What the plan read. Fingerprint, apply, and verify all work from it. */
  state: S
  summary: string
  effects: PlanEffect[]
  warnings: string[]
}

export interface ActionSpec<P extends TObject, S> {
  /** Shown to the model on the discriminator; keep it to one line. */
  description: string
  params: P
  /**
   * Resolves the target against live state and reports the effect set. It
   * fails for a target that does not exist. Apply runs it again to re-read.
   */
  plan: (
    params: Static<P>,
    signal: AbortSignal | undefined,
  ) => Effect.Effect<Planned<S>, ToolFailure>
  /**
   * The fields of that state which decide the effect set. Computed from the
   * state `plan` returned, so the two cannot disagree. `undefined` needs its
   * reason stated in the contract.
   */
  fingerprint: ((state: S, params: Static<P>) => JsonValue) | undefined
  /** The write, working from the state apply just re-read. */
  apply: (
    params: Static<P>,
    state: S,
  ) => Effect.Effect<JsonValue | undefined, ToolFailure>
  /** The read-back. Its failure is reported next to the result. */
  verify?: (
    params: Static<P>,
    result: JsonValue,
    state: S,
  ) => Effect.Effect<JsonValue, ToolFailure>
}

export interface Action {
  description: string
  params: TObject
  plan: (
    params: JsonObject,
    signal: AbortSignal | undefined,
  ) => Effect.Effect<Planned<unknown>, ToolFailure>
  fingerprint: ((state: unknown, params: JsonObject) => JsonValue) | undefined
  apply: (
    params: JsonObject,
    state: unknown,
  ) => Effect.Effect<JsonValue | undefined, ToolFailure>
  verify:
    | ((
        params: JsonObject,
        result: JsonValue,
        state: unknown,
      ) => Effect.Effect<JsonValue, ToolFailure>)
    | undefined
}

/** One entry of a service's plan/apply table. */
export function action<P extends TObject, S>(spec: ActionSpec<P, S>): Action {
  const fingerprint = spec.fingerprint
  const verify = spec.verify
  // SAFETY: arguments are checked against `params` before a plan exists, and
  // the state handed back is always the one this action's own `plan` made.
  return {
    description: spec.description,
    params: spec.params,
    plan: (params, signal) => spec.plan(params as Static<P>, signal),
    fingerprint: fingerprint
      ? (state, params) => fingerprint(state as S, params as Static<P>)
      : undefined,
    apply: (params, state) => spec.apply(params as Static<P>, state as S),
    verify: verify
      ? (params, result, state) =>
          verify(params as Static<P>, result, state as S)
      : undefined,
  }
}

const PLAN_OUTPUT = Type.Object({
  planId: Type.String({ description: "Pass to the service's _apply tool" }),
  service: Type.String(),
  action: Type.String(),
  summary: Type.String(),
  effects: Type.Array(
    Type.Object({
      kind: Type.String(),
      target: Type.String(),
      detail: Type.Optional(Type.String()),
    }),
  ),
  warnings: Type.Array(Type.String()),
  expiresAt: Type.String({ description: "ISO time the plan ends" }),
})

const APPLY_INPUT = Type.Object(
  { planId: Type.String({ description: "A planId a _plan call returned" }) },
  { additionalProperties: false },
)

/** The `<service>_plan` and `<service>_apply` tools over a table of actions. */
export function definePlanApply(
  service: string,
  actions: Record<string, Action>,
  plans: PlanStore,
): [ServerTool, ServerTool] {
  const variants = variantSchemas("action", actions)
  const names = [...variants.keys()].join(", ")
  const planTool: ServerTool = {
    name: `${service}_plan`,
    description:
      `Plan one ${service} write. Changes nothing: it resolves the target against live state and returns a planId, ` +
      `the effect set, and warnings. Actions: ${names}.`,
    inputSchema: unionSchema("action", variants),
    outputSchema: { ...PLAN_OUTPUT, type: "object" },
    annotations: { readOnlyHint: true, openWorldHint: false },
    label: (args) => variantName("action", variants, args),
    execute: (args, signal) =>
      Effect.gen(function* () {
        const call = yield* selectVariant(
          `${service}_plan`,
          "action",
          variants,
          args,
        )
        const spec = actions[call.name]
        if (!spec) return yield* toolFail(`unknown action ${call.name}`)
        const planned = yield* spec.plan(call.params, signal)
        const fingerprint = yield* toolCheck(() =>
          spec.fingerprint?.(planned.state, call.params),
        )
        const plan = plans.create({
          service,
          action: call.name,
          params: call.params,
          fingerprint,
        })
        return jsonResult({
          planId: plan.planId,
          service,
          action: call.name,
          summary: planned.summary,
          effects: planned.effects,
          warnings: planned.warnings,
          expiresAt: new Date(plan.expiresAt).toISOString(),
        })
      }).pipe(withDeadline(`${service}_plan`)),
  }
  const applyTool: ServerTool = {
    name: `${service}_apply`,
    description:
      `Apply one ${service} plan by planId. Re-reads the planned state first and fails with "plan is stale" when it ` +
      "changed. Returns the write's result and a verification read-back. Applying a planId again returns the first " +
      "outcome with replayed: true and runs nothing. An unknown write outcome requires operator review.",
    inputSchema: { ...APPLY_INPUT, type: "object" },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
    label: (args) =>
      isPlainObject(args) && typeof args.planId === "string"
        ? plans.actionOf(args.planId)
        : undefined,
    execute: (args) =>
      Effect.gen(function* () {
        const params = yield* checkArgs(`${service}_apply`, APPLY_INPUT, args)
        const planId = params.planId
        // Deliberately not tied to the request: once a write may have been
        // sent, a client that goes away must not leave it half-recorded.
        const reply = yield* Effect.promise(() =>
          plans.apply(service, planId, (plan) =>
            Effect.runPromise(applyAttempt(service, actions, plan)),
          ),
        )
        if (!reply.ok) return yield* toolFail(reply.message)
        return applyResult(planId, reply.action, reply.outcome, reply.replayed)
      }),
  }
  return [planTool, applyTool]
}

/**
 * One apply: re-read, compare fingerprints, write, verify. It never fails;
 * what happened to the plan is the value.
 */
function applyAttempt(
  service: string,
  actions: Record<string, Action>,
  plan: StoredPlan,
): Effect.Effect<ApplyAttempt> {
  const label = `${service} ${plan.action}`
  // Decides how a crash is reported: before the write nothing has changed,
  // after it the result is unknown and the plan must stay consumed.
  let writeSent = false
  return Effect.gen(function* () {
    const spec = actions[plan.action]
    if (!spec) {
      return stale(`plan is stale: ${label} is no longer available`)
    }
    const reread = yield* spec.plan(plan.params, undefined).pipe(
      Effect.timeoutOrElse({
        duration: REREAD_TIMEOUT_MS,
        orElse: () =>
          Effect.fail(new HttpTimeoutError({ timeoutMs: REREAD_TIMEOUT_MS })),
      }),
      Effect.match({
        onSuccess: (planned) => ({ ok: true as const, planned }),
        onFailure: (error) => ({ ok: false as const, error }),
      }),
    )
    if (!reread.ok) {
      // The plan's own guards reject a target that is gone or changed shape.
      return targetGone(reread.error)
        ? stale(`plan is stale: ${failureMessage(reread.error)}`)
        : untouched(
            `could not re-read ${service} state before applying, so nothing was written: ${failureMessage(reread.error)}`,
          )
    }
    const state = reread.planned.state
    if (spec.fingerprint) {
      const changes = fingerprintDiff(
        plan.fingerprint,
        spec.fingerprint(state, plan.params),
      )
      if (changes.length > 0) {
        return stale(
          `plan is stale: ${changes.join("; ")}. Nothing was written. Read the state again and plan again.`,
        )
      }
    }

    writeSent = true
    const written = yield* spec.apply(plan.params, state).pipe(
      Effect.match({
        onSuccess: (result) => ({ ok: true as const, result }),
        onFailure: (error) => ({ ok: false as const, error }),
      }),
    )
    if (!written.ok) {
      const reason = failureMessage(written.error)
      // A 4xx is the service refusing the write. Anything else, a timeout
      // above all, leaves it unknown whether the write went through.
      const rejected =
        written.error._tag === "HttpError" &&
        written.error.status >= 400 &&
        written.error.status < 500
      return applied({
        ok: false,
        writeOutcome: rejected ? "rejected" : "unknown",
        message: rejected
          ? `${label} was rejected by the service and changed nothing: ${reason}. The plan is consumed. Plan again once the cause is fixed.`
          : `${label} failed and its result is unknown: ${reason}. The plan is consumed and the write may or may not have taken effect. Operator review is required before another write.`,
      })
    }
    const result = written.result ?? { ok: true }
    const verify = spec.verify
    if (!verify) return applied({ ok: true, result })
    // A verification that fails or throws must not hide the completed write.
    return yield* Effect.suspend(() => verify(plan.params, result, state)).pipe(
      Effect.timeoutOrElse({
        duration: VERIFY_TIMEOUT_MS,
        orElse: () =>
          Effect.fail(new HttpTimeoutError({ timeoutMs: VERIFY_TIMEOUT_MS })),
      }),
      Effect.map((verification) => applied({ ok: true, result, verification })),
      Effect.catchCause((cause) =>
        Effect.succeed(
          applied({
            ok: true,
            result,
            verificationError: failureMessage(Cause.squash(cause)),
          }),
        ),
      ),
    )
  }).pipe(
    Effect.catchCause((cause) => {
      const message = failureMessage(Cause.squash(cause))
      return Effect.succeed(
        writeSent
          ? applied({
              ok: false,
              writeOutcome: "unknown",
              message: `${label} crashed after its write was sent: ${message}. The plan is consumed. Operator review is required before another write.`,
            })
          : untouched(
              `${label} could not start, so nothing was written: ${message}`,
            ),
      )
    }),
  )
}

function applied(outcome: ApplyOutcome): ApplyAttempt {
  return { kind: "applied", outcome }
}

function stale(message: string): ApplyAttempt {
  return { kind: "stale", message }
}

function untouched(message: string): ApplyAttempt {
  return { kind: "untouched", message }
}

/**
 * A re-read that fails this way means the planned target moved, not that the
 * service is unwell: a plan guard rejected it, or the service says 404.
 */
function targetGone(error: ToolFailure): boolean {
  if (error._tag === "ToolError") return true
  return error._tag === "HttpError" && error.status === 404
}

const MAX_OUTCOME_PART_CHARS = 12_000

/** The `text` block is what the model reads, so it has to stay whole. */
function applyResult(
  planId: string,
  actionName: string,
  outcome: ApplyOutcome,
  replayed: boolean,
): ToolResult {
  if (!outcome.ok) {
    return {
      ...errorResult(
        replayed
          ? `${outcome.message} (replayed: this is the recorded outcome of the first apply; nothing ran again)`
          : outcome.message,
      ),
      // A successful MCP exchange does not establish whether the service wrote.
      // Keep that distinction machine-readable, including when replaying it.
      structuredContent: {
        planId,
        action: actionName,
        writeOutcome: outcome.writeOutcome,
        replayed,
      },
    }
  }
  return jsonResult({
    planId,
    action: actionName,
    ...(replayed ? { replayed: true } : {}),
    result: bounded(outcome.result),
    ...(outcome.verification !== undefined
      ? { verification: bounded(outcome.verification) }
      : {}),
    ...(outcome.verificationError !== undefined
      ? { verificationError: outcome.verificationError }
      : {}),
  })
}

/** Cuts one oversized part so the other parts survive the text cap. */
function bounded(value: JsonValue): JsonValue {
  const text = JSON.stringify(value)
  if (text.length <= MAX_OUTCOME_PART_CHARS) return value
  return `${text.slice(0, MAX_OUTCOME_PART_CHARS)}... [truncated ${text.length - MAX_OUTCOME_PART_CHARS} chars]`
}

function withDeadline(name: string) {
  return <A>(
    effect: Effect.Effect<A, ToolFailure>,
  ): Effect.Effect<A, ToolFailure> =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: CALL_DEADLINE_MS,
        orElse: () =>
          toolFail(`${name} did not finish within ${CALL_DEADLINE_MS} ms`),
      }),
    )
}

type Discriminator = "resource" | "action"

/** The closed schema of each variant, discriminator included. */
function variantSchemas(
  discriminator: Discriminator,
  table: Record<string, { description: string; params: TObject }>,
): Map<string, TObject> {
  return new Map(
    Object.entries(table).map(([name, variant]) => [
      name,
      Type.Object(
        {
          [discriminator]: Type.Literal(name, {
            description: variant.description,
          }),
          ...variant.params.properties,
        },
        { additionalProperties: false },
      ),
    ]),
  )
}

/**
 * `type: "object"` with the discriminator on top and one closed variant per
 * value. Codemode renders the `anyOf` as a TypeScript union.
 */
function unionSchema(
  discriminator: Discriminator,
  variants: Map<string, TObject>,
): ToolSchema {
  return {
    type: "object",
    properties: {
      [discriminator]: { type: "string", enum: [...variants.keys()] },
    },
    required: [discriminator],
    anyOf: [...variants.values()],
  }
}

/** Only ever a known variant name: an argument value is never logged. */
function variantName(
  discriminator: Discriminator,
  variants: Map<string, TObject>,
  args: unknown,
): string | undefined {
  const name = isPlainObject(args) ? args[discriminator] : undefined
  return typeof name === "string" && variants.has(name) ? name : undefined
}

function selectVariant(
  tool: string,
  discriminator: Discriminator,
  variants: Map<string, TObject>,
  args: unknown,
): Effect.Effect<{ name: string; params: JsonObject }, ToolError> {
  return toolCheck(() => {
    const name = variantName(discriminator, variants, args)
    const schema = name === undefined ? undefined : variants.get(name)
    if (name === undefined || schema === undefined) {
      throw new Error(
        `invalid arguments for ${tool}: ${discriminator} must be one of ${[...variants.keys()].join(", ")}`,
      )
    }
    if (!Check(schema, args)) {
      throw new Error(
        `invalid arguments for ${tool} ${name}: ${describeErrors(schema, args)}`,
      )
    }
    // SAFETY: the arguments arrived as JSON and passed the variant's schema.
    const params = Object.fromEntries(
      Object.entries(args as JsonObject).filter(
        ([key]) => key !== discriminator,
      ),
    )
    return { name, params }
  })
}

/** Argument validation for a tool with one closed input schema. */
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

/** One line per offending field, named the way the caller wrote it. */
function describeErrors(schema: TObject, value: unknown): string {
  const lines = Errors(schema, value).flatMap((error) => {
    const path = error.instancePath.replace(/^\//, "").replaceAll("/", ".")
    const at = path ? `${path}: ` : ""
    // Each rejected member of a union also reports its own mismatch.
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

/**
 * The text a failed call returns. `fetch` hides why a connection failed in a
 * nested cause, and "fetch failed" alone tells the model nothing.
 */
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

const PLACEHOLDER_ORIGIN = "http://service.invalid"

/**
 * Admits a caller-chosen GET path only below `prefix` on the service itself.
 * Resolved the way the HTTP helper does: `/http://host`, `///host`, or
 * `/api/v3/../..` would otherwise reach another host or another API.
 */
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

/**
 * A raw response is not compacted, so settings endpoints would hand over
 * the keys this server exists to hold. Masks secret-named fields, the
 * `{ name, value }` pairs Arr settings use, and any of `secrets` verbatim.
 */
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
