import { stat } from "node:fs/promises"

import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { Effect } from "effect"

import type { Config } from "../config.ts"
import {
  threadKey,
  type Channel,
  type Marker,
  type Inbound,
  type Notice,
  type ThreadRef,
  type Threads,
} from "../gateway.ts"
import { JobStore } from "../jobs.ts"
import { connectMcpEffect } from "../mcp/client.ts"
import { storageIO } from "../storage.ts"
import { buildRunTools, type SessionFileRef } from "../tools/index.ts"
import { buildWebProvider } from "../web/index.ts"
import { SdkError } from "./effect.ts"
import { queuedMessage, workingMessage } from "./notices.ts"
import { buildMessagePrompt, buildSystemPrompt } from "./prompt.ts"
import {
  modelAnchor,
  resolveModel,
  runAgentTurnEffect,
  usageAnchor,
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
    private readonly threads: Threads,
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
    return showEffect(this.threads.channel(thread), marker, {
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
      const channel = this.threads.channel(thread)
      return yield* Effect.gen({ self: this }, function* () {
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
        const storageFile = this.threads.sessionFile(thread)
        const resuming = yield* storageIO(() => stat(storageFile)).pipe(
          Effect.map((s) => s.isFile()),
          Effect.catch(() => Effect.succeed(false)),
        )

        // One connection per run, closed with the scope below. A server that
        // is down fails the run here, before the model is ever asked.
        const mcp = yield* connectMcpEffect(this.config.mcp)
        const web = buildWebProvider(this.config.web)
        const runTools = buildRunTools({
          modelInput: resolveModel(this.modelRuntime, this.modelSpec).input,
          mcp,
          history: this.threads.sessionsDir(thread),
          sessionFileRef,
        })
        const tools = [...runTools.tools, ...web.tools]

        const prompt = yield* this.jobs.actionEffect(
          runId,
          "prompt",
          Effect.sync(() => buildMessagePrompt(event, context, resuming)),
          { replaySafe: true },
        )
        const turn = yield* runAgentTurnEffect({
          modelRuntime: this.modelRuntime,
          modelSpec: this.modelSpec,
          systemPrompt: buildSystemPrompt({
            brief: channel.brief,
            language: this.config.language,
            web: { search: web.searchTool, extract: web.extractTool },
            toolNames: tools.map((tool) => tool.name),
          }),
          tools,
          loadableTools: runTools.loadable,
          prompt,
          storageFile,
          requestId: runId,
          sessionFileRef,
        })
        if (turn.failure)
          return yield* Effect.fail(
            new SdkError({
              message: turn.failure.message,
              cause: turn.failure,
            }),
          )

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
                  signature: usageAnchor(this.modelSpec, turn.usage),
                }
              : undefined,
          ).pipe(Effect.as({ reply: reply || null })),
        )
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

  /** Recovery of a cancelled job stops its Durable work and never calls the model. */
  cancelEffect(
    event: Inbound,
    status: Marker,
    requestId: string,
  ): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* () {
      const thread = event.thread
      const storageFile = this.threads.sessionFile(thread)
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
      // Only a job that reached the model can have left work in the
      // conversation. An earlier job of this thread may still own the rest.
      const began = actions.some(
        (action) => action.key === "prompt" && action.completed,
      )
      const exists = yield* storageIO(() => stat(storageFile)).pipe(
        Effect.map((file) => file.isFile()),
        Effect.catch(() => Effect.succeed(false)),
      )
      // An aborted turn opens the conversation only to abort what this job
      // left pending, so the thread's next run does not find it.
      if (began && exists)
        yield* runAgentTurnEffect({
          modelRuntime: this.modelRuntime,
          modelSpec: this.modelSpec,
          storageFile,
          requestId,
          systemPrompt: "This host job was cancelled. Do not execute work.",
          prompt: "",
          tools: [],
          builtinRead: false,
          sessionFileRef: undefined,
          signal: AbortSignal.abort(),
        })
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
      return publishEffect(this.threads.channel(thread), status, undefined)
    })
  }
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
