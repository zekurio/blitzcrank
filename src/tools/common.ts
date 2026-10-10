import path from "node:path"

import { StringEnum } from "@earendil-works/pi-ai"
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable"
import { Cause, Data, Effect } from "effect"
import { Type } from "typebox"

import type { JsonValue } from "../services/http.ts"
import type { RunContext } from "./context.ts"
import { assertServicePath, type Method, type Route } from "./safety.ts"

export const MAX_RESULT_CHARS = 30_000

type TextResultValue = JsonValue | MutationOutcome

export function toText(data: TextResultValue): string {
  const text = isString(data) ? data : JSON.stringify(data, null, 2)
  if (text == null) return "null"
  if (text.length <= MAX_RESULT_CHARS) return text
  return `${text.slice(0, MAX_RESULT_CHARS)}\n... [truncated ${text.length - MAX_RESULT_CHARS} chars — narrow your query]`
}

export type ToolResultDetails = Record<string, string | number | boolean | null>

export function textResult(
  data: TextResultValue,
  details: ToolResultDetails = {},
) {
  return { content: [{ type: "text" as const, text: toText(data) }], details }
}

export type ServiceName = "seerr" | "sonarr" | "radarr" | "jellyfin" | "sabnzbd"

const SERVICE_PATH_FIELDS = new Map<ServiceName, ReadonlySet<string>>([
  ["sonarr", new Set(["path", "outputPath"])],
  ["radarr", new Set(["path", "outputPath", "droppedPath", "importedPath"])],
  ["sabnzbd", new Set(["storage"])],
  ["jellyfin", new Set(["Path", "path"])],
])

/** Records only absolute strings from fields declared to carry service paths. */
function recordResponsePaths(
  ctx: RunContext,
  service: ServiceName,
  data: JsonValue,
  fields: ReadonlySet<string> = SERVICE_PATH_FIELDS.get(service) ?? new Set(),
): void {
  const pending: Array<JsonValue | undefined> = [data]
  const seen = new WeakSet<object>()
  while (pending.length > 0) {
    const value = pending.pop()
    if (Array.isArray(value)) {
      if (seen.has(value)) continue
      seen.add(value)
      pending.push(...value)
      continue
    }
    if (!isJsonObject(value) || seen.has(value)) continue
    seen.add(value)
    for (const [key, child] of Object.entries(value)) {
      if (
        fields.has(key) &&
        isString(child) &&
        path.isAbsolute(child) &&
        !child.includes("\0")
      ) {
        ctx.recordPath(service, child, key)
      }
      if (child !== undefined && child !== null && !isString(child)) {
        pending.push(child)
      }
    }
  }
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

export interface RequestToolSpec<E> {
  service: ServiceName
  description: string
  methods: readonly [Method, ...Method[]]
  route: (method: Method, path: string, body: JsonValue | undefined) => Route
  request: (
    method: Method,
    path: string,
    body: JsonValue | undefined,
  ) => Effect.Effect<JsonValue, E>
}

/**
 * A tool whose replay safety depends on its arguments. The SDK's `replay`
 * flag is per tool, so the Durable wrapper asks `writes` per call.
 */
export type HostTool = ToolRegistration & {
  writes?: ((args: unknown) => boolean) | undefined
}

interface RequestArgs {
  method: Method
  path: string
  body?: Record<string, unknown> | undefined
}

/**
 * Raw service request tool. `spec.route` decides per call whether it reads,
 * writes, or is refused; every response is recorded as evidence.
 */
export function makeRequestTool<E>(
  spec: RequestToolSpec<E>,
  ctx: RunContext,
): HostTool {
  // SAFETY: tool bodies are parsed JSON objects validated by the schema.
  const routeOf = (args: RequestArgs) =>
    spec.route(args.method, args.path, args.body as JsonValue | undefined)
  const tool = defineTool({
    name: `${spec.service}_request`,
    // Per-call safety comes from `writes`; reads may always be repeated.
    replay: "safe",
    description: spec.description,
    parameters: Type.Object({
      reason: Type.String({
        description: "What this request should establish or change, and why",
      }),
      method: StringEnum(spec.methods),
      path: Type.String({
        description:
          "Service-relative path starting with /, including any query string. Never a full URL or credentials.",
      }),
      body: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "JSON body for POST or PUT",
        }),
      ),
    }),
    execute(params) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const route = yield* toolCheck(() => {
            assertServicePath(params.path)
            if (params.method === "GET" && params.body !== undefined)
              throw new Error("GET requests take no body")
            const route = routeOf(params)
            if (route.kind === "refused") throw new Error(route.message)
            return route
          })
          if (route.kind === "write") ctx.noteMutation("mutate")
          const data = yield* spec.request(
            params.method,
            params.path,
            params.body as JsonValue | undefined,
          )
          ctx.recordRead(
            spec.service,
            params.path,
            isString(data) ? data : JSON.stringify(data),
          )
          recordResponsePaths(ctx, spec.service, data)
          return textResult(data ?? { ok: true }, {
            service: spec.service,
            method: params.method,
            path: params.path,
          })
        }),
      )
    },
  })
  return Object.assign(tool, {
    // SAFETY: the SDK validates arguments against the schema before execution.
    writes: (args: unknown) => {
      const request = args as RequestArgs
      return request.path.startsWith("/") && routeOf(request).kind === "write"
    },
  })
}

export interface EvidenceRequirement {
  service: ServiceName
  value: string | number
  hint: string
  /** Require a typed identity record rather than a raw JSON substring. */
  identity?: boolean
}

export interface MutationOutcome {
  result: JsonValue
  verification?: JsonValue
  verificationError?: string
}

/**
 * Shared mutation pipeline: evidence gates -> audit counter -> perform ->
 * built-in verification read. Verification failures never mask a completed
 * mutation.
 */
export function runMutation<E, R, E2 = never, R2 = never>(
  ctx: RunContext,
  opts: {
    kind: "mutate" | "delete"
    evidence?: EvidenceRequirement[]
    perform: () => Effect.Effect<JsonValue, E, R>
    verify?: (result: JsonValue) => Effect.Effect<JsonValue, E2, R2>
  },
): Effect.Effect<MutationOutcome, E | ToolError, R | R2> {
  return Effect.gen(function* () {
    yield* toolCheck(() => {
      for (const e of opts.evidence ?? []) {
        if (e.identity === true) {
          ctx.requireIdentity(e.service, e.value, e.hint)
          continue
        }
        ctx.requireEvidence(e.service, e.value, e.hint)
      }
    })
    ctx.noteMutation(opts.kind)
    const result = yield* opts.perform()
    const verify = opts.verify
    if (!verify) return { result }
    return yield* Effect.suspend(() => verify(result)).pipe(
      Effect.map((verification): MutationOutcome => ({ result, verification })),
      // A thrown parser error must not hide a completed write either. Fiber
      // interruption remains interruption, not a successful verification result.
      Effect.catchCause((cause) => {
        if (Cause.hasInterrupts(cause)) return Effect.interrupt
        const error = Cause.squash(cause)
        return Effect.succeed({
          result,
          verificationError:
            error instanceof Error ? error.message : String(error),
        })
      }),
    )
  })
}

export const reasonParam = () =>
  Type.String({
    description:
      "Why this exact action is needed and safe; name the exact verified target",
  })

function isString<Value>(value: Value): value is Value & string {
  return typeof value === "string"
}

function isJsonObject(
  value: JsonValue | undefined,
): value is { [key: string]: JsonValue | undefined } {
  return (
    value !== undefined &&
    value !== null &&
    Object(value) === value &&
    !Array.isArray(value)
  )
}
