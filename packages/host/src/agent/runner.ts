import { stat } from "node:fs/promises"

import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { Effect } from "effect"

import { clampEntries, clampEntry, type CaseFile } from "../casefile.ts"
import type { Config } from "../config.ts"
import {
  threadKey,
  type Channel,
  type Gateways,
  type Marker,
  type Inbound,
  type Notice,
  type ThreadRef,
} from "../gateway.ts"
import { JobStore } from "../jobs.ts"
import { connectMcpEffect } from "../mcp/client.ts"
import { storageIO } from "../storage.ts"
import { buildRunTools, type SessionFileRef } from "../tools/index.ts"
import type { RunIntents } from "../tools/outcome.ts"
import { buildWebProvider } from "../web/index.ts"
import { SdkError } from "./effect.ts"
import { buildMessagePrompt, buildSystemPrompt } from "./prompt.ts"
import {
  modelAnchor,
  resolveModel,
  runAgentTurnEffect,
  usageAnchor,
  type AgentTurnOptions,
  type AgentTurnResult,
} from "./session.ts"

/**
 * Runs one event of one thread. It reaches the outside only through the
 * thread's channel, so it does not know which gateway the thread belongs to.
 */
export class ThreadRunner {
  constructor(
    private readonly config: Config,
    private readonly modelRuntime: ModelRuntime,
    private readonly modelSpec: string,
    private readonly jobs: JobStore,
    private readonly gateways: Gateways,
  ) {}

  get anchor(): string {
    return modelAnchor(this.modelSpec)
  }

  /**
   * Shows a status line before a delayed run reaches the front of the serial
   * queue. The run adopts the returned marker, so its working line and its
   * reply rewrite this message instead of adding another.
   */
  notifyQueuedEffect(thread: ThreadRef, runsAhead: number) {
    const marker: Marker = { id: undefined }
    return showEffect(this.channel(thread), marker, {
      text: queuedMessage(this.config.language, runsAhead),
      signature: this.anchor,
    })
  }

  runEffect(
    event: Inbound,
    status: Marker,
    runId: string,
  ): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* () {
      const thread = event.thread
      const key = threadKey(thread)
      const gateway = this.gateways.of(thread)
      const channel = gateway.channel(thread.id)
      const cases = this.gateways.cases(thread)
      return yield* Effect.gen({ self: this }, function* () {
        // Every recovery projects this same baseline plus this submission's
        // totals. A crash after saving cannot count the run twice.
        const casefile = yield* this.jobs.actionEffect(
          runId,
          "case-baseline",
          cases.loadEffect(thread.id),
          { replaySafe: true },
        )
        // The reporter sees that work started. The reply rewrites this same
        // message, and a run that dies first removes it, so a run leaves one
        // message at most.
        const shown = yield* this.jobs.actionEffect(
          runId,
          "working-notice",
          showEffect(channel, status, {
            text: workingMessage(this.config.language),
            signature: this.anchor,
          }),
        )
        status.id = shown.id
        const context = yield* channel.contextEffect()
        const sessionFileRef: SessionFileRef = { current: undefined }
        // The clean cut never opens old coding-agent JSONL. Existing case
        // summaries remain useful when the first Durable conversation starts.
        const storageFile = this.gateways.sessionFile(thread)
        const resuming = yield* storageIO(() => stat(storageFile)).pipe(
          Effect.map((s) => s.isFile()),
          Effect.catch(() => Effect.succeed(false)),
        )

        // One connection per run, closed with the scope below. A server that
        // is down fails the run here, before the model is ever asked.
        const mcp = yield* connectMcpEffect(this.config.mcp)
        const web = buildWebProvider(this.config.web)
        const intents: RunIntents = { close: false }
        const runTools = buildRunTools({
          modelInput: resolveModel(this.modelRuntime, this.modelSpec).input,
          mcp,
          history: this.gateways.dirs(thread),
          sessionFileRef,
          casefile,
          intents,
          close: channel.close,
        })
        const tools = [...runTools.tools, ...web.tools]

        const prompt = yield* this.jobs.actionEffect(
          runId,
          "prompt",
          Effect.sync(() =>
            buildMessagePrompt(event, context, casefile, resuming),
          ),
          { replaySafe: true },
        )
        const turn = yield* runAgentTurnEffect({
          modelRuntime: this.modelRuntime,
          modelSpec: this.modelSpec,
          systemPrompt: buildSystemPrompt({
            brief: gateway.brief,
            language: this.config.language,
            web: { search: web.searchTool, extract: web.extractTool },
            toolNames: tools.map((tool) => tool.name),
          }),
          tools,
          loadableTools: runTools.loadable,
          prompt,
          storageFile,
          requestId: runId,
          hostState: runState(casefile, intents),
          sessionFileRef,
        })

        // Usage is recorded before any reply: a failure while publishing must
        // not make a run invisible in the thread's running total.
        projectSpend(casefile, turn)
        casefile.sessionFile = turn.sessionFile
        yield* cases.saveEffect(casefile)

        if (turn.failure) {
          casefile.runs.push({
            at: new Date().toISOString(),
            tokens: turn.usage.newTokens,
            inputTokens: turn.usage.inputTokens,
            outputTokens: turn.usage.outputTokens,
            commented: false,
            resolved: false,
          })
          yield* cases.saveEffect(casefile)
          return yield* Effect.fail(
            new SdkError({
              message: turn.failure.message,
              cause: turn.failure,
            }),
          )
        }

        const reply = turn.text.trim()
        if (!reply) {
          console.warn(
            `[${key}] run ended without a final message; nothing posted`,
          )
        }
        // Once publication begins its outcome can be uncertain. Never retract
        // a marker that might now carry the reply after a crash.
        yield* this.jobs.actionEffect(
          runId,
          "publish-reply",
          publishEffect(
            channel,
            status,
            reply
              ? {
                  text: reply,
                  signature: usageAnchor(
                    this.modelSpec,
                    casefile.spend.tokens,
                    casefile.spend.inputTokens,
                    casefile.spend.outputTokens,
                    turn.usage.costUsd === undefined
                      ? undefined
                      : casefile.spend.costUsd,
                    turn.usage.costUsd,
                  ),
                }
              : undefined,
          ).pipe(Effect.as({ reply: reply || null })),
        )

        // After the reply, so a thread is never closed without its answer.
        const close = intents.close ? channel.close : undefined
        if (close)
          yield* this.jobs.actionEffect(runId, "close-thread", close.effect())

        // Host-written, so continuity survives a run that never called the tool.
        if (reply) casefile.lastAnswer = clampEntry(reply)
        const completedAt = yield* this.jobs.actionEffect(
          runId,
          "completed-at",
          Effect.sync(() => Date.now()),
          { replaySafe: true },
        )
        casefile.runs.push({
          at: new Date(completedAt).toISOString(),
          tokens: turn.usage.newTokens,
          inputTokens: turn.usage.inputTokens,
          outputTokens: turn.usage.outputTokens,
          commented: reply !== "",
          resolved: close !== undefined,
        })
        yield* cases.saveEffect(casefile)
      }).pipe(
        // Releases the MCP connection when the run exits.
        Effect.scoped,
        Effect.onExit(() =>
          this.jobs
            .actionEffect(
              runId,
              "retract-status",
              this.retractStatusEffect(thread, status, runId),
            )
            .pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => {
                  console.error(`[${key}] failed to retract status:`, cause)
                }),
              ),
            ),
        ),
      )
    }).pipe(Effect.uninterruptible)
  }

  /** Recovery of a cancelled job restores audit/state but cannot call the model. */
  cancelEffect(
    event: Inbound,
    status: Marker,
    requestId: string,
  ): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* () {
      const thread = event.thread
      const cases = this.gateways.cases(thread)
      const storageFile = this.gateways.sessionFile(thread)
      const actions = this.jobs.actions(requestId)
      // The run may have replaced the queue notice's marker with its own. An
      // unrecorded working line fails here for review.
      if (actions.some((action) => action.key === "working-notice")) {
        const shown = yield* this.jobs.actionEffect<Marker, Error>(
          requestId,
          "working-notice",
          Effect.fail(new Error("Missing recorded working notice")),
        )
        status.id = shown.id
      }
      const began = actions.some(
        (action) => action.key === "case-baseline" && action.completed,
      )
      const exists = yield* storageIO(() => stat(storageFile)).pipe(
        Effect.map((file) => file.isFile()),
        Effect.catch(() => Effect.succeed(false)),
      )
      if (began && exists) {
        const casefile = yield* this.jobs.actionEffect(
          requestId,
          "case-baseline",
          cases.loadEffect(thread.id),
          { replaySafe: true },
        )
        const turn = yield* runAgentTurnEffect({
          modelRuntime: this.modelRuntime,
          modelSpec: this.modelSpec,
          storageFile,
          requestId,
          systemPrompt: "This host job was cancelled. Do not execute work.",
          prompt: "",
          tools: [],
          builtinRead: false,
          hostState: runState(casefile, { close: false }),
          sessionFileRef: undefined,
          signal: AbortSignal.abort(),
        })
        projectSpend(casefile, turn)
        casefile.sessionFile = turn.sessionFile
        const published = actions.some(
          (action) => action.key === "publish-reply" && action.completed,
        )
          ? yield* this.jobs.actionEffect<{ reply: string | null }, Error>(
              requestId,
              "publish-reply",
              Effect.fail(new Error("Missing recorded reply outcome")),
            )
          : undefined
        if (published?.reply) casefile.lastAnswer = clampEntry(published.reply)
        casefile.runs.push({
          at: new Date().toISOString(),
          tokens: turn.usage.newTokens,
          inputTokens: turn.usage.inputTokens,
          outputTokens: turn.usage.outputTokens,
          commented: Boolean(published?.reply),
          resolved: actions.some(
            (action) => action.key === "close-thread" && action.completed,
          ),
        })
        yield* cases.saveEffect(casefile)
      }
      yield* this.jobs.actionEffect(
        requestId,
        "retract-status",
        this.retractStatusEffect(thread, status, requestId),
      )
    }).pipe(Effect.uninterruptible)
  }

  retractStatusEffect(thread: ThreadRef, status: Marker, requestId: string) {
    return Effect.suspend(() => {
      // Consult durable intent, not a flag in this process: even initialization
      // can fail while recovering a job whose reply was already published.
      if (
        this.jobs
          .actions(requestId)
          .some((action) => action.key === "publish-reply")
      )
        return Effect.void
      return publishEffect(this.channel(thread), status, undefined)
    })
  }

  private channel(thread: ThreadRef): Channel {
    return this.gateways.of(thread).channel(thread.id)
  }
}

/** What the run's tools change in the host, checkpointed with their results. */
function runState(
  casefile: CaseFile,
  intents: RunIntents,
): NonNullable<AgentTurnOptions["hostState"]> {
  return {
    capture: () => ({
      summary: {
        ...casefile.summary,
        hypothesis: casefile.summary.hypothesis ?? null,
      },
      close: intents.close,
    }),
    restore: (value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid persisted run state")
      const summary = value.summary
      if (
        summary === null ||
        typeof summary !== "object" ||
        Array.isArray(summary)
      )
        throw new Error("Invalid persisted case summary")
      casefile.summary = {
        hypothesis: clampEntry(summary.hypothesis),
        facts: clampEntries(summary.facts),
        ruledOut: clampEntries(summary.ruledOut),
        openQuestions: clampEntries(summary.openQuestions),
      }
      intents.close = value.close === true
    },
  }
}

function projectSpend(casefile: CaseFile, turn: AgentTurnResult): void {
  casefile.spend = {
    runs: casefile.spend.runs + 1,
    tokens: casefile.spend.tokens + turn.usage.newTokens,
    inputTokens:
      casefile.spend.inputTokens === undefined
        ? undefined
        : casefile.spend.inputTokens + turn.usage.inputTokens,
    outputTokens:
      casefile.spend.outputTokens === undefined
        ? undefined
        : casefile.spend.outputTokens + turn.usage.outputTokens,
    costUsd:
      casefile.spend.costUsd === undefined
        ? undefined
        : casefile.spend.costUsd + (turn.usage.costUsd ?? 0),
  }
}

function isGerman(language: string): boolean {
  return /^(de|deutsch|german)(-|_|\b)/i.test(language.trim())
}

function queuedMessage(language: string, runsAhead: number): string {
  if (isGerman(language)) {
    const ahead =
      runsAhead === 1
        ? "Eine Aufgabe ist noch vor ihr."
        : `${runsAhead} Aufgaben sind noch vor ihr.`
    return `⏳ Blitzcrank ist gerade beschäftigt. Deine Meldung ist eingereiht. ${ahead}`
  }
  const ahead =
    runsAhead === 1
      ? "One task is ahead of it."
      : `${runsAhead} tasks are ahead of it.`
  return `⏳ Blitzcrank is currently busy. Your report is queued. ${ahead}`
}

function workingMessage(language: string): string {
  return isGerman(language)
    ? "🔎 Blitzcrank sieht sich deine Meldung an."
    : "🔎 Blitzcrank is looking into your report."
}

/** Shows a notice and returns the marker it now lives under, for the journal. */
function showEffect(channel: Channel, marker: Marker, notice: Notice) {
  return channel.showEffect(marker, notice).pipe(
    Effect.map((): Marker => ({ id: marker.id })),
    Effect.uninterruptible,
  )
}

/**
 * Publishes the run's one visible message over its status line, or removes
 * the line when there is nothing to say. The marker is cleared on success: it
 * is gone, or now carries the reply, so a run failing after this point must
 * not retract it.
 */
export function publishEffect(
  channel: Pick<Channel, "showEffect" | "retractEffect">,
  marker: Marker,
  notice: Notice | undefined,
) {
  return (
    notice === undefined
      ? channel.retractEffect(marker)
      : channel.showEffect(marker, notice)
  ).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        marker.id = undefined
      }),
    ),
    Effect.uninterruptible,
  )
}
