import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent"
import type { ToolRegistration } from "@earendil-works/pi-durable"
import { Effect } from "effect"

import { SIGNATURE_PREFIX } from "../gateway.ts"
import { parseModelSpec } from "./durable-model.ts"
import { runDurableTurn } from "./durable.ts"
import { SdkError } from "./effect.ts"

export {
  parseModelSpec,
  resolveModel,
  type ParsedModelSpec,
} from "./durable-model.ts"

export function modelAnchor(spec: string): string {
  const parsed = parseModelSpec(spec)
  return `${SIGNATURE_PREFIX} ${parsed.modelId}:${parsed.thinkingLevel}]`
}
/** A thread's totals over every run, from Durable's ledger of its conversation. */
export interface ThreadUsage {
  /** Fresh input and cache writes. Cache reads are left out. */
  inputTokens: number
  outputTokens: number
  /** At list prices. Undefined unless the provider bills per token. */
  costUsd: number | undefined
}
function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}
function formatCost(costUsd: number): string {
  return `$${costUsd.toFixed(costUsd < 0.01 ? 4 : 2)}`
}
export function usageAnchor(spec: string, usage: ThreadUsage): string {
  const prefix = modelAnchor(spec).slice(0, -1)
  const cost =
    usage.costUsd === undefined ? "" : ` · ${formatCost(usage.costUsd)}`
  return `${prefix} · ${formatTokens(usage.inputTokens)} in · ${formatTokens(usage.outputTokens)} out${cost}]`
}
export interface AgentTurnOptions {
  modelRuntime: ModelRuntime
  modelSpec: string
  systemPrompt: string
  tools: ToolRegistration[]
  /**
   * Names in `tools` the conversation does not offer until a tool result
   * loads them with `control.addTools`.
   */
  loadableTools?: readonly string[] | undefined
  prompt: string
  storageFile: string | undefined
  requestId: string
  sessionFileRef: { current: string | undefined } | undefined
  builtinRead?: boolean
  signal?: AbortSignal | undefined
}
export interface DurableTurnFailure {
  kind: "unsafe-interrupted" | "policy-changed" | "unanswered"
  message: string
  toolNames: string[]
}
export interface AgentTurnResult {
  /** The message that ended the run, from the submission's answer entry. */
  text: string
  usage: ThreadUsage
  failure?: DurableTurnFailure
}
/** Coding-agent supplies auth and discovery, never execution. */
export function runAgentTurnEffect(
  opts: AgentTurnOptions,
): Effect.Effect<AgentTurnResult, SdkError> {
  const skillsDir = path.join(
    fileURLToPath(new URL("../..", import.meta.url)),
    "skills",
  )
  return Effect.callback<AgentTurnResult, SdkError>((resume, interruption) => {
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, interruption])
      : interruption
    const completion = (async () => {
      const skills = loadSkillsFromDir({ dir: skillsDir, source: "deployment" })
      const skillsPrompt =
        opts.builtinRead === false
          ? ""
          : formatSkillsForPrompt(
              skills.skills.map((skill) => ({
                ...skill,
                // Nix store paths change on rebuild. Skill locations are
                // relative to the read tool's fixed deployment root.
                filePath: path.relative(skillsDir, skill.filePath),
              })),
            )
      return runDurableTurn({
        ...opts,
        signal,
        systemPrompt: `${opts.systemPrompt}\n${skillsPrompt}`,
        skillsDir,
      })
    })().then(
      (result) => resume(Effect.succeed(result)),
      (cause: unknown) =>
        resume(
          Effect.fail(
            new SdkError({
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
          ),
        ),
    )
    // Interrupting the waiter requests a graceful stop, then joins the owned
    // invocation. It cannot dispose a tool between its write and read-back.
    return Effect.promise(() => completion).pipe(Effect.uninterruptible)
  })
}
