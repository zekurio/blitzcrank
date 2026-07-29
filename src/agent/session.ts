import { mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { AssistantMessage } from "@earendil-works/pi-ai"
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"

import { BOT_COMMENT_MARKER } from "../webhook/loop-guard.js"

export const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5"

const THINKING_LEVELS = /^(.*?):(off|minimal|low|medium|high|xhigh|max)$/
type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"

export interface ParsedModelSpec {
  provider: string
  modelId: string
  thinkingLevel: ThinkingLevel
}

/** Parse "provider/model[:thinking]", e.g. "openai-codex/gpt-5.2-codex:high". */
export function parseModelSpec(spec: string): ParsedModelSpec {
  const suffix = spec.match(THINKING_LEVELS)
  const base = suffix ? suffix[1]! : spec
  const thinkingLevel = suffix ? (suffix[2] as ThinkingLevel) : "medium"
  const slash = base.indexOf("/")
  if (slash === -1) {
    throw new Error(
      `BLITZCRANK_MODEL must be "provider/model[:thinking]", got "${spec}"`,
    )
  }
  return {
    provider: base.slice(0, slash),
    modelId: base.slice(slash + 1),
    thinkingLevel,
  }
}

/** Comment footer identity, e.g. "[blitzcrank w/ gpt-5.2-codex:high]". */
export function modelAnchor(spec: string): string {
  const parsed = parseModelSpec(spec)
  return `${BOT_COMMENT_MARKER} ${parsed.modelId}:${parsed.thinkingLevel}]`
}

export interface RunUsage {
  totalTokens: number
  cost: number
}

/**
 * Accumulates usage as assistant messages complete.
 *
 * Summing `session.messages` after the run does not work: auto-compaction
 * replaces that array with a summary plus the recent tail, so exactly the
 * expensive runs this exists to stop would under-report their own cost.
 */
export class RunUsageTracker {
  readonly usage: RunUsage = { totalTokens: 0, cost: 0 }
  private tripped = false

  constructor(
    private readonly ceiling: number | undefined,
    private readonly spent: number,
  ) {}

  /** Adds one message's usage; true the first time the ceiling is crossed. */
  add(usage: { totalTokens: number; cost: { total: number } }): boolean {
    this.usage.totalTokens += usage.totalTokens
    this.usage.cost += usage.cost.total
    if (this.ceiling === undefined || this.tripped) return false
    if (this.spent + this.usage.cost < this.ceiling) return false
    this.tripped = true
    return true
  }

  get total(): number {
    return this.spent + this.usage.cost
  }
}

/**
 * Aborting is a request, not an outcome: a ceiling crossed on the run's final
 * message cuts nothing short. Only a genuinely interrupted run reports
 * `stopReason: "aborted"`, and only that run's answer is missing.
 */
export function turnStopReason(
  requestedAbort: boolean,
  stopReason: string | undefined,
): "cost_ceiling" | undefined {
  return requestedAbort && stopReason === "aborted" ? "cost_ceiling" : undefined
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}

/** Anchor plus usage, e.g. "[blitzcrank w/ gpt-5.2-codex:high · 48.2k tokens · $0.19]". */
export function usageAnchor(spec: string, usage: RunUsage): string {
  const cost = `$${usage.cost.toFixed(usage.cost >= 0.1 ? 2 : 3)}`
  return `${modelAnchor(spec).slice(0, -1)} · ${formatTokens(usage.totalTokens)} tokens · ${cost}]`
}

/** Repo root (contains skills/): two levels up from dist/agent/. */
const projectRoot = path.resolve(new URL("../..", import.meta.url).pathname)
const skillsDir = path.join(projectRoot, "skills")

export function resolveModel(modelRuntime: ModelRuntime, spec: string) {
  const parsed = parseModelSpec(spec)
  const model = modelRuntime.getModel(parsed.provider, parsed.modelId)
  if (!model) throw new Error(`Unknown model: ${spec}`)
  return model
}

export interface AgentTurnOptions {
  modelRuntime: ModelRuntime
  modelSpec: string
  systemPrompt: string
  tools: ToolDefinition[]
  prompt: string
  /** Persist the session transcript (JSONL) into this directory when set. */
  sessionDir: string | undefined
  /** Receives the session file path once known, for history self-exclusion. */
  sessionFileRef: { current: string | undefined } | undefined
  logPrefix: string
  /**
   * Hard spend ceiling in USD for this run, counted together with what the
   * issue already cost. Reaching it aborts the agent loop mid-run: a ceiling
   * that only reports after the fact is not a ceiling.
   */
  costCeiling?: number | undefined
  /** Cost already attributed to this issue before the run. */
  costSpent?: number | undefined
}

/**
 * One locked-down agent turn: our skills only, our tools plus builtin `read`
 * (for SKILL.md loading), no extensions/context discovery, run to completion,
 * return the final assistant text plus aggregate token usage/cost.
 */
export interface AgentTurnResult {
  text: string
  usage: RunUsage
  /** Set when the run was stopped by the host rather than by the model. */
  stopped: "cost_ceiling" | undefined
}

export async function runAgentTurn(
  opts: AgentTurnOptions,
): Promise<AgentTurnResult> {
  const cwd = path.join(os.tmpdir(), "blitzcrank-work")
  await mkdir(cwd, { recursive: true })
  if (opts.sessionDir) await mkdir(opts.sessionDir, { recursive: true })

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: path.join(os.tmpdir(), "blitzcrank-agent-noop"),
    additionalSkillPaths: [skillsDir],
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    skillsOverride: (current) => ({
      skills: current.skills.filter((s) => s.filePath.startsWith(skillsDir)),
      diagnostics: current.diagnostics,
    }),
    systemPromptOverride: () => opts.systemPrompt,
    appendSystemPromptOverride: () => [],
  })
  await loader.reload()

  const { session } = await createAgentSession({
    cwd,
    model: resolveModel(opts.modelRuntime, opts.modelSpec),
    thinkingLevel: parseModelSpec(opts.modelSpec).thinkingLevel,
    modelRuntime: opts.modelRuntime,
    resourceLoader: loader,
    customTools: opts.tools,
    tools: [...opts.tools.map((t) => t.name), "read"],
    sessionManager: opts.sessionDir
      ? SessionManager.create(cwd, opts.sessionDir)
      : SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true },
    }),
  })

  if (opts.sessionFileRef) opts.sessionFileRef.current = session.sessionFile

  // Live cost tracking: assistant messages carry final usage as they complete,
  // so the ceiling can stop the loop instead of describing the damage later.
  const tracker = new RunUsageTracker(opts.costCeiling, opts.costSpent ?? 0)
  let aborting: Promise<void> | undefined

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      console.log(
        `[${opts.logPrefix}] tool ${event.toolName}`,
        JSON.stringify(event.args),
      )
      return
    }
    if (event.type === "tool_execution_end" && event.isError) {
      console.warn(`[${opts.logPrefix}] tool ${event.toolName} failed`)
      return
    }
    if (event.type !== "message_end" || event.message.role !== "assistant") {
      return
    }
    if (!tracker.add(event.message.usage)) return
    console.warn(
      `[${opts.logPrefix}] cost ceiling $${opts.costCeiling?.toFixed(2)} reached ` +
        `(issue total $${tracker.total.toFixed(2)}); aborting run`,
    )
    // Compaction runs on its own controller and would keep spending after the
    // agent loop stops, so it is cancelled too.
    session.abortCompaction()
    aborting = session.abort().catch((err: unknown) => {
      console.warn(`[${opts.logPrefix}] abort failed:`, err)
    })
  })

  try {
    await session.prompt(opts.prompt)

    const lastAssistant = session.messages.findLast(
      (m): m is AssistantMessage => m.role === "assistant",
    )
    if (!lastAssistant) throw new Error("agent produced no assistant message")
    if (lastAssistant.stopReason === "error") {
      throw new Error(lastAssistant.errorMessage ?? "model request failed")
    }

    return {
      text: lastAssistant.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join(""),
      usage: tracker.usage,
      stopped: turnStopReason(aborting !== undefined, lastAssistant.stopReason),
    }
  } finally {
    // The prompt resolves as soon as the loop stops; a requested abort still
    // has to settle before the session is disposed.
    if (aborting) await aborting
    unsubscribe()
    session.dispose()
  }
}
