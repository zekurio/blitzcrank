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
  /**
   * Tokens this run added to the conversation: prompt input, cache writes and
   * output. Cache *reads* are excluded on purpose. Every turn re-reads the
   * whole prefix, so summing `totalTokens` across turns counts the same
   * context once per turn and grows with the square of the turn count: a
   * 19-turn run measured 829k that way, of which 738k was one context read
   * nineteen times. This is the number a human can act on.
   */
  newTokens: number
  /** Sum of per-turn `totalTokens`, cache reads included: volume, not work. */
  billedTokens: number
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}

/**
 * Anchor plus usage, e.g. "[blitzcrank w/ gpt-5.2-codex:high · 132.4k tokens]".
 *
 * The count is everything the issue has cost so far, not this run alone: a run
 * leaves exactly one comment and each comment replaces the last one, so a
 * per-run number would silently understate an issue that took four runs.
 *
 * It counts `newTokens`, not billed volume. The reporter reads this figure as
 * "how much work was this", and cache reads answer a different question.
 */
export function usageAnchor(spec: string, issueTokens: number): string {
  return `${modelAnchor(spec).slice(0, -1)} · ${formatTokens(issueTokens)} tokens]`
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
}

/**
 * One locked-down agent turn: our skills only, our tools plus builtin `read`
 * (for SKILL.md loading), no extensions/context discovery, run to completion,
 * return the final assistant text plus aggregate token usage/cost.
 */
export interface AgentTurnResult {
  text: string
  usage: RunUsage
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

  // Usage is accumulated as assistant messages complete, not summed from
  // `session.messages` afterwards: auto-compaction replaces that array with a
  // summary plus the recent tail, so the longest runs would under-report most.
  const usage: RunUsage = { newTokens: 0, billedTokens: 0 }

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
    if (event.type === "message_end" && event.message.role === "assistant") {
      const turn = event.message.usage
      // `reasoning` is already part of `output`; adding it would double-count.
      usage.newTokens += turn.input + turn.cacheWrite + turn.output
      usage.billedTokens += turn.totalTokens
    }
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
      usage,
    }
  } finally {
    unsubscribe()
    session.dispose()
  }
}
