import path from "node:path"

import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

import type { RunContext } from "./context.js"
import { assertServicePath } from "./safety.js"

export const MAX_RESULT_CHARS = 30_000

export function toText(data: unknown): string {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2)
  if (text == null) return "null"
  if (text.length <= MAX_RESULT_CHARS) return text
  return `${text.slice(0, MAX_RESULT_CHARS)}\n... [truncated ${text.length - MAX_RESULT_CHARS} chars — narrow your query]`
}

export function textResult(
  data: unknown,
  details: Record<string, unknown> = {},
) {
  return { content: [{ type: "text" as const, text: toText(data) }], details }
}

export type ServiceName = "seerr" | "sonarr" | "radarr" | "jellyfin" | "sabnzbd"

const SERVICE_PATH_FIELDS: Partial<Record<ServiceName, ReadonlySet<string>>> = {
  sonarr: new Set(["path", "outputPath"]),
  radarr: new Set(["path", "outputPath"]),
  sabnzbd: new Set(["storage"]),
  jellyfin: new Set(["Path", "path"]),
}

/** Records only absolute strings from fields declared to carry service paths. */
function recordResponsePaths(
  ctx: RunContext,
  service: ServiceName,
  data: unknown,
  fields: ReadonlySet<string> = SERVICE_PATH_FIELDS[service] ?? new Set(),
): void {
  const pending: unknown[] = [data]
  const seen = new WeakSet<object>()
  while (pending.length > 0) {
    const value = pending.pop()
    if (!value || typeof value !== "object" || seen.has(value)) continue
    seen.add(value)
    if (Array.isArray(value)) {
      pending.push(...value)
      continue
    }
    for (const [key, child] of Object.entries(value)) {
      if (
        fields.has(key) &&
        typeof child === "string" &&
        path.isAbsolute(child) &&
        !child.includes("\0")
      ) {
        ctx.recordPath(service, child)
      }
      if (child && typeof child === "object") pending.push(child)
    }
  }
}

export interface ReadToolSpec {
  service: ServiceName
  label: string
  description: string
  /** Extra deterministic guards beyond assertServicePath. */
  guards?: (path: string) => void
  request: (path: string) => Promise<unknown>
}

/** GET-only raw request tool for investigation. Every read is recorded as evidence. */
export function makeReadTool(
  spec: ReadToolSpec,
  ctx: RunContext,
): ToolDefinition {
  return defineTool({
    name: `${spec.service}_request`,
    label: spec.label,
    description: `${spec.description} Read-only (GET): all state changes go through dedicated tools.`,
    parameters: Type.Object({
      purpose: Type.String({
        description:
          "What evidence this read should produce for the current diagnosis",
      }),
      path: Type.String({
        description:
          "Service-relative path starting with /, including any query string. Never a full URL or credentials.",
      }),
    }),
    async execute(_toolCallId, params) {
      assertServicePath(params.path)
      spec.guards?.(params.path)
      const data = await spec.request(params.path)
      ctx.recordRead(
        spec.service,
        params.path,
        typeof data === "string" ? data : JSON.stringify(data),
      )
      recordResponsePaths(ctx, spec.service, data)
      return textResult(data, {
        service: spec.service,
        method: "GET",
        path: params.path,
      })
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
  result: unknown
  verification?: unknown
  verificationError?: string
}

/**
 * Shared mutation pipeline: evidence gates -> budget -> perform -> built-in
 * verification read. Verification failures never mask a completed mutation.
 */
export async function runMutation(
  ctx: RunContext,
  opts: {
    kind: "mutate" | "delete"
    evidence?: EvidenceRequirement[]
    perform: () => Promise<unknown>
    verify?: (result: unknown) => Promise<unknown>
  },
): Promise<MutationOutcome> {
  for (const e of opts.evidence ?? []) {
    if (e.identity === true) {
      ctx.requireIdentity(e.service, e.value, e.hint)
      continue
    }
    ctx.requireEvidence(e.service, e.value, e.hint)
  }
  ctx.noteMutation(opts.kind)
  const result = await opts.perform()
  if (!opts.verify) return { result }
  try {
    return { result, verification: await opts.verify(result) }
  } catch (err) {
    return {
      result,
      verificationError: err instanceof Error ? err.message : String(err),
    }
  }
}

export const reasonParam = () =>
  Type.String({
    description:
      "Why this exact action is needed and safe; name the exact verified target",
  })
