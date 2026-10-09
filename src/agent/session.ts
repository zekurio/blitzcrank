import path from "node:path"
import { fileURLToPath } from "node:url"

import type { JsonValue } from "@earendil-works/chord"
import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent"
import type { ToolRegistration } from "@earendil-works/pi-durable"
import { Effect } from "effect"

import { BOT_COMMENT_MARKER } from "../gateways/seerr/loop-guard.ts"
import type { RunContext } from "../tools/context.ts"
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
  return `${BOT_COMMENT_MARKER} ${parsed.modelId}:${parsed.thinkingLevel}]`
}
export interface RunUsage {
  inputTokens: number
  outputTokens: number
  newTokens: number
  billedTokens: number
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
export function usageAnchor(
  spec: string,
  issueTokens: number,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  costUsd: number | undefined,
  runCostUsd: number | undefined,
): string {
  const prefix = modelAnchor(spec).slice(0, -1)
  const cost =
    costUsd !== undefined
      ? ` · ${formatCost(costUsd)}`
      : runCostUsd !== undefined
        ? ` · ${formatCost(runCostUsd)} this run`
        : ""
  if (inputTokens === undefined || outputTokens === undefined)
    return `${prefix} · ${formatTokens(issueTokens)} tokens${cost}]`
  return `${prefix} · ${formatTokens(inputTokens)} in · ${formatTokens(outputTokens)} out${cost}]`
}
export interface AgentTurnOptions {
  modelRuntime: ModelRuntime
  modelSpec: string
  systemPrompt: string
  tools: ToolRegistration[]
  prompt: string
  storageFile: string | undefined
  requestId: string
  runContext?: RunContext | undefined
  hostState?:
    | {
        capture: () => JsonValue
        restore: (value: JsonValue) => void
      }
    | undefined
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
  text: string
  usage: RunUsage
  sessionFile: string | undefined
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
