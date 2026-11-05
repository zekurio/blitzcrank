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
/** A tool call a run starts, for the thread's live status line. */
export interface ToolStep {
  tool: string
  /** Whether the call may write: true unless the tool is safe to replay. */
  write: boolean
}
/** One tool call as the model sent it. */
export interface PendingCall {
  id: string
  tool: string
  arguments: Readonly<Record<string, unknown>>
}
/** An earlier turn of the conversation, as the transcript holds it. */
export interface ConversationTurn {
  /** `prompt` is a turn the host built around a message, `reply` a final answer. */
  role: "prompt" | "reply"
  text: string
}
export interface WriteReviewRequest {
  call: PendingCall
  /** Every call of the response `call` came in, itself included, in order. */
  round: readonly PendingCall[]
  /** The prompt this run answers, as the transcript holds it. */
  prompt: string
  /** Earlier prompts and replies, oldest first, cut from the oldest end. */
  earlier: readonly ConversationTurn[]
  signal: AbortSignal | undefined
}
/**
 * Reviews a write before it starts. A call it blocks never runs, and its
 * reason goes back to the model as an error result.
 */
export interface WriteReview {
  /** Whether calls of this tool wait for `check`. */
  reviews(tool: string): boolean
  /** Undefined lets the call run; a string says why it may not. */
  check(request: WriteReviewRequest): Promise<string | undefined>
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
  /**
   * Hears each tool call before it starts, never one replayed from the
   * journal. It runs inside tool execution, so it must return at once.
   */
  onToolStep?: ((step: ToolStep) => void) | undefined
  /**
   * Reviews each call of the tools it names before it is journaled, so a
   * call it holds up never leaves a write uncertain. Never a replayed call.
   */
  review?: WriteReview | undefined
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
const SKILLS_DIR = path.join(
  fileURLToPath(new URL("../..", import.meta.url)),
  "skills",
)

/**
 * The deployment's skills, as the system prompt lists them. They ship with
 * the package and cannot change while the host runs, so they are read once.
 */
const SKILLS_PROMPT = formatSkillsForPrompt(
  loadSkillsFromDir({ dir: SKILLS_DIR, source: "deployment" }).skills.map(
    (skill) => ({
      ...skill,
      // Nix store paths change on rebuild. Skill locations are relative to
      // the read tool's fixed deployment root.
      filePath: path.relative(SKILLS_DIR, skill.filePath),
    }),
  ),
)

/** Coding-agent supplies auth and discovery, never execution. */
export function runAgentTurnEffect(
  opts: AgentTurnOptions,
): Effect.Effect<AgentTurnResult, SdkError> {
  return Effect.callback<AgentTurnResult, SdkError>((resume, interruption) => {
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, interruption])
      : interruption
    const skills = opts.builtinRead === false ? "" : SKILLS_PROMPT
    const completion = runDurableTurn({
      ...opts,
      signal,
      systemPrompt: `${opts.systemPrompt}\n${skills}`,
      skillsDir: SKILLS_DIR,
    }).then(
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
