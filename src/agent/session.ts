import { mkdir, stat } from "node:fs/promises"
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
    throw new Error(`model must be "provider/model[:thinking]", got "${spec}"`)
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
  /** Prompt input plus cache writes; cache reads are excluded. */
  inputTokens: number
  /** Model output, including reasoning. */
  outputTokens: number
  /** `inputTokens + outputTokens`, retained for aggregate reporting. */
  newTokens: number
  /** Sum of per-turn `totalTokens`, cache reads included: volume, not work. */
  billedTokens: number
  /** API-price estimate in USD; undefined when authenticated through OAuth. */
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

/**
 * Anchor plus cumulative issue usage, e.g.
 * "[blitzcrank w/ gpt-5.2-codex:high · 118.2k in · 14.2k out]".
 *
 * Cache reads are excluded. Legacy case files only have a combined count, so
 * they keep the old honest total rather than mislabeling historical tokens or
 * cost. When cumulative cost is unavailable, show this run's API-price estimate.
 */
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
  if (inputTokens === undefined || outputTokens === undefined) {
    return `${prefix} · ${formatTokens(issueTokens)} tokens${cost}]`
  }
  return `${prefix} · ${formatTokens(inputTokens)} in · ${formatTokens(outputTokens)} out${cost}]`
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
  /**
   * Existing session JSONL to continue instead of starting a new one. The
   * whole prior conversation is replayed into context; the system prompt and
   * tool set are *not* replayed, so a resumed run still gets this run's
   * prompt and this run's registry. Ignored when the file no longer exists.
   */
  resumeFile: string | undefined
  /** Receives the session file path once known, for history self-exclusion. */
  sessionFileRef: { current: string | undefined } | undefined
  /** Observe completed tool calls without exposing their arguments or results. */
  onToolExecutionEnd?: (toolName: string, isError: boolean) => void
  logPrefix: string
}

/**
 * One locked-down agent turn: our skills only, our tools plus builtin `read`
 * (for SKILL.md loading), no extensions/context discovery, run to completion,
 * return the final assistant text plus aggregate token usage/cost.
 */
export interface AgentTurnResult {
  text: string
  /** Tool names in the final live assistant message, in source order. */
  finalToolNames: string[]
  usage: RunUsage
  /** Where the transcript lives, so the next run can resume it. */
  sessionFile: string | undefined
  resumed: boolean
}

/**
 * The session manager for this run: resume when we were handed a file that is
 * still there, otherwise start fresh.
 *
 * The existence check is not optional. `SessionManager.open()` on a missing
 * path silently starts an empty session pointed at that path instead of
 * failing, so without the `stat` a deleted transcript would look like a
 * successful resume and the run would quietly lose the issue's history.
 */
async function openSession(
  resumeFile: string | undefined,
  sessionDir: string | undefined,
  cwd: string,
): Promise<{ manager: SessionManager; resumed: boolean }> {
  if (resumeFile !== undefined) {
    const exists = await stat(resumeFile).then(
      (s) => s.isFile(),
      () => false,
    )
    if (exists) {
      return {
        manager: SessionManager.open(resumeFile, sessionDir),
        resumed: true,
      }
    }
  }
  return {
    manager: sessionDir
      ? SessionManager.create(cwd, sessionDir)
      : SessionManager.inMemory(cwd),
    resumed: false,
  }
}

export async function runAgentTurn(
  opts: AgentTurnOptions,
): Promise<AgentTurnResult> {
  const cwd = path.join(os.tmpdir(), "blitzcrank-work")
  await mkdir(cwd, { recursive: true })
  if (opts.sessionDir) await mkdir(opts.sessionDir, { recursive: true })

  const opened = await openSession(opts.resumeFile, opts.sessionDir, cwd)
  if (opened.resumed) {
    console.log(`[${opts.logPrefix}] resuming ${opts.resumeFile}`)
  }

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
    sessionManager: opened.manager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true },
    }),
  })

  if (opts.sessionFileRef) opts.sessionFileRef.current = session.sessionFile

  // Usage is accumulated as assistant messages complete, not summed from
  // `session.messages` afterwards: auto-compaction replaces that array with a
  // summary plus the recent tail, so the longest runs would under-report most.
  const auth = await opts.modelRuntime.checkAuth(
    parseModelSpec(opts.modelSpec).provider,
  )
  const usage: RunUsage = {
    inputTokens: 0,
    outputTokens: 0,
    newTokens: 0,
    billedTokens: 0,
    // OAuth covers subscription-style authentication. If auth cannot be
    // classified, omit dollars rather than present a potentially fictional
    // list-price estimate as money actually spent.
    costUsd: auth?.type === "api_key" ? 0 : undefined,
  }
  // Captured from the event stream rather than read back off `session.messages`
  // afterwards. On a resumed session that array opens already populated, so a
  // `findLast` for an assistant message can return one from a *previous* run
  // when this run produced none — and the caller parses that text as this
  // run's directive block. A stale RESOLVE_ISSUE would then close an issue
  // nobody looked at. Only messages seen live can belong to this run.
  let final: AssistantMessage | undefined

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      console.log(
        `[${opts.logPrefix}] tool ${event.toolName}`,
        JSON.stringify(event.args),
      )
      return
    }
    if (event.type === "tool_execution_end") {
      opts.onToolExecutionEnd?.(event.toolName, event.isError)
      if (event.isError) {
        console.warn(`[${opts.logPrefix}] tool ${event.toolName} failed`)
      }
      return
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      final = event.message
      const turn = event.message.usage
      // `reasoning` is already part of `output`; adding it would double-count.
      usage.inputTokens += turn.input + turn.cacheWrite
      usage.outputTokens += turn.output
      usage.newTokens += turn.input + turn.cacheWrite + turn.output
      usage.billedTokens += turn.totalTokens
      if (usage.costUsd !== undefined) usage.costUsd += turn.cost.total
    }
  })

  try {
    await session.prompt(opts.prompt)

    if (!final) throw new Error("agent produced no assistant message")
    if (final.stopReason === "error") {
      throw new Error(final.errorMessage ?? "model request failed")
    }

    return {
      text: final.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join(""),
      finalToolNames: final.content
        .filter((b) => b.type === "toolCall")
        .map((b) => b.name),
      usage,
      sessionFile: session.sessionFile,
      resumed: opened.resumed,
    }
  } finally {
    unsubscribe()
    session.dispose()
  }
}
