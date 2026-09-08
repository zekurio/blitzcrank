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
  type AgentSession,
} from "@earendil-works/pi-coding-agent"
import { Effect } from "effect"

import { BOT_COMMENT_MARKER } from "../gateways/seerr/loop-guard.ts"
import { sdkPromise, SdkError } from "./effect.ts"

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
  const thinkingLevel = thinkingLevelOf(suffix?.[2])
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

function thinkingLevelOf(value: string | undefined): ThinkingLevel {
  switch (value) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return value
    default:
      return "medium"
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
  /** Continue the newest session in sessionDir, or create one when empty. */
  continueSession?: boolean
  /** Receives the session file path once known, for history self-exclusion. */
  sessionFileRef: { current: string | undefined } | undefined
  /** Observe completed tool calls without exposing their arguments or results. */
  onToolExecutionEnd?: (toolName: string, isError: boolean) => void
  logPrefix: string
  /** Register builtin read for loading deployment skills. Default true. */
  builtinRead?: boolean
  /** Stops the live turn after any tool call already in flight returns. */
  signal?: AbortSignal | undefined
}

/**
 * One locked-down agent turn: our skills and tools, optional builtin `read`
 * for SKILL.md loading, no ambient extensions or context discovery. Run to
 * completion and return the final text plus aggregate token usage and cost.
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
 * Resume an exact file when supplied. A durable conversation can instead
 * continue the newest session in its own directory. Other runs start fresh.
 *
 * The existence check is not optional. `SessionManager.open()` on a missing
 * path silently starts an empty session pointed at that path instead of
 * failing, so without the `stat` a deleted transcript would look like a
 * successful resume and the run would quietly lose the issue's history.
 */
function openSessionEffect(
  resumeFile: string | undefined,
  sessionDir: string | undefined,
  cwd: string,
  continueSession: boolean,
) {
  return Effect.gen(function* () {
    if (resumeFile !== undefined) {
      const exists = yield* sdkPromise(() => stat(resumeFile)).pipe(
        Effect.map((s) => s.isFile()),
        Effect.catch(() => Effect.succeed(false)),
      )
      if (exists) {
        return {
          manager: SessionManager.open(resumeFile, sessionDir),
          resumed: true,
        }
      }
    }
    if (continueSession) {
      if (!sessionDir) {
        return yield* Effect.fail(
          new SdkError({
            message: "continueSession requires sessionDir",
            cause: undefined,
          }),
        )
      }
      const manager = SessionManager.continueRecent(cwd, sessionDir)
      return { manager, resumed: manager.getEntries().length > 0 }
    }
    return {
      manager: sessionDir
        ? SessionManager.create(cwd, sessionDir)
        : SessionManager.inMemory(cwd),
      resumed: false,
    }
  })
}

export function runAgentTurn(opts: AgentTurnOptions): Promise<AgentTurnResult> {
  return Effect.runPromise(runAgentTurnEffect(opts))
}

export function runAgentTurnEffect(
  opts: AgentTurnOptions,
): Effect.Effect<AgentTurnResult, SdkError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const cwd = path.join(os.tmpdir(), "blitzcrank-work")
      yield* sdkPromise(() => mkdir(cwd, { recursive: true }))
      if (opts.sessionDir)
        yield* sdkPromise(() => mkdir(opts.sessionDir!, { recursive: true }))

      const opened = yield* openSessionEffect(
        opts.resumeFile,
        opts.sessionDir,
        cwd,
        opts.continueSession ?? false,
      )
      if (opened.resumed) {
        console.log(
          `[${opts.logPrefix}] resuming ${opts.resumeFile ?? opts.sessionDir}`,
        )
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
          skills: current.skills.filter((s) =>
            s.filePath.startsWith(skillsDir),
          ),
          diagnostics: current.diagnostics,
        }),
        systemPromptOverride: () => opts.systemPrompt,
        appendSystemPromptOverride: () => [],
      })
      yield* sdkPromise(() => loader.reload())
      const extensionErrors = loader.getExtensions().errors
      if (extensionErrors.length > 0) {
        return yield* Effect.fail(
          new SdkError({
            cause: extensionErrors,
            message: `extensions are disabled but reported errors: ${extensionErrors
              .map((error) => `${error.path}: ${error.error}`)
              .join("; ")}`,
          }),
        )
      }

      const { session } = yield* sdkPromise(() =>
        createAgentSession({
          cwd,
          model: resolveModel(opts.modelRuntime, opts.modelSpec),
          thinkingLevel: parseModelSpec(opts.modelSpec).thinkingLevel,
          modelRuntime: opts.modelRuntime,
          resourceLoader: loader,
          customTools: opts.tools.map((tool) => ({
            ...tool,
            execute: (...args) => {
              // Pi can prepare a parallel batch before any call starts.
              if (opts.signal?.aborted) throw new Error("agent turn aborted")
              return tool.execute(...args)
            },
          })),
          tools: [
            ...opts.tools.map((t) => t.name),
            ...(opts.builtinRead === false ? [] : ["read"]),
          ],
          sessionManager: opened.manager,
          settingsManager: SettingsManager.inMemory({
            compaction: { enabled: true },
          }),
        }),
      )
      return yield* runSessionEffect(session, opts, opened.resumed)
    }),
  ).pipe(Effect.uninterruptible)
}

/** Own an SDK session from setup through its final tool verification. */
export function runSessionEffect(
  session: Pick<
    AgentSession,
    | "bindExtensions"
    | "sessionFile"
    | "subscribe"
    | "abort"
    | "prompt"
    | "dispose"
  >,
  opts: Pick<
    AgentTurnOptions,
    | "modelSpec"
    | "sessionFileRef"
    | "logPrefix"
    | "onToolExecutionEnd"
    | "signal"
    | "prompt"
  > & { modelRuntime: Pick<ModelRuntime, "checkAuth"> },
  resumed: boolean,
): Effect.Effect<AgentTurnResult, SdkError> {
  return Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(Effect.succeed(session), (session) =>
        Effect.sync(() => session.dispose()),
      )
      yield* sdkPromise(() => session.bindExtensions({ mode: "print" }))

      if (opts.sessionFileRef) opts.sessionFileRef.current = session.sessionFile

      // Usage is accumulated as assistant messages complete, not summed from
      // `session.messages` afterwards: auto-compaction replaces that array with a
      // summary plus the recent tail, so the longest runs would under-report most.
      const auth = yield* sdkPromise(() =>
        opts.modelRuntime.checkAuth(parseModelSpec(opts.modelSpec).provider),
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
      let activeTools = 0
      let abortRequested = false

      let abortCompletion: Promise<void> | undefined
      const abortSession = (): void => {
        abortCompletion ??= session.abort().catch((err: unknown) => {
          console.warn(`[${opts.logPrefix}] failed to abort agent turn:`, err)
        })
      }
      const abort = (): void => {
        abortRequested = true
        if (activeTools === 0) abortSession()
      }

      const unsubscribe = session.subscribe((event) => {
        if (event.type === "tool_execution_start") {
          activeTools += 1
          return
        }
        if (event.type === "tool_execution_end") {
          activeTools -= 1
          opts.onToolExecutionEnd?.(event.toolName, event.isError)
          if (event.isError) {
            console.warn(`[${opts.logPrefix}] tool ${event.toolName} failed`)
          }
          if (abortRequested && activeTools === 0) abortSession()
          return
        }
        if (
          event.type === "message_end" &&
          event.message.role === "assistant"
        ) {
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
      opts.signal?.addEventListener("abort", abort, { once: true })

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          opts.signal?.removeEventListener("abort", abort)
          if (abortCompletion)
            yield* sdkPromise(() => abortCompletion!).pipe(Effect.orDie)
          unsubscribe()
        }),
      )
      if (opts.signal?.aborted)
        return yield* Effect.fail(
          new SdkError({ message: "agent turn aborted", cause: undefined }),
        )
      yield* sdkPromise(() => session.prompt(opts.prompt))

      if (opts.signal?.aborted) {
        // The host must save usage and evidence even when it discards the answer.
        return {
          text: "",
          finalToolNames: [],
          usage,
          sessionFile: session.sessionFile,
          resumed,
        }
      }
      if (!final)
        return yield* Effect.fail(
          new SdkError({
            message: "agent produced no assistant message",
            cause: undefined,
          }),
        )
      if (final.stopReason === "aborted") {
        return yield* Effect.fail(
          new SdkError({ message: "agent turn aborted", cause: undefined }),
        )
      }
      if (final.stopReason === "error") {
        return yield* Effect.fail(
          new SdkError({
            message: final.errorMessage ?? "model request failed",
            cause: final,
          }),
        )
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
        resumed,
      }
      // Host stop signals wait for in-flight tool verification before aborting.
      // Fiber interruption must not dispose the SDK while those writes are active.
    }),
  ).pipe(Effect.uninterruptible)
}
