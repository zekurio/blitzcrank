import { stat } from "node:fs/promises"
import { text } from "node:stream/consumers"

import { Effect } from "effect"

import type { Gateway, Inbound, Threads } from "../../gateway.ts"
import { storageIO } from "../../storage.ts"

const NAME = "cli"

/** Names a thread's files, so it stays within `ThreadRef.id`'s characters. */
const THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/

const USAGE =
  'stdin must hold one JSON event: {"thread":"<id>","text":"<message>"}'

// Worded like the chat gateways' brief without their platform, so a run here
// behaves as it would in a Discord or Fluxer thread.
const BRIEF =
  "Each conversation is one chat thread with a member allowed to use the bot. " +
  "Every event is that member's latest message and comes with nothing else; earlier messages and your prior replies are in this conversation. " +
  "Your final message is posted in the thread. Keep it under 1,500 characters. The member answers by writing in the thread. " +
  "The member's name is not given, and no name identifies a Seerr or Jellyfin account; never match one by name."

/** One line the `run` command writes to stdout. */
export type CliEvent =
  | { type: "run.started"; runId: string; thread: string }
  | { type: "step"; tool: string; write: boolean }
  | { type: "reply"; text: string }
  | {
      type: "usage"
      /** Totals over every run of the thread, not this run alone. */
      inputTokens: number
      outputTokens: number
      costUsd: number | null
    }
  | {
      type: "run.finished"
      runId: string
      status: "completed" | "failed"
      error?: string
    }

/** Stdout carries these lines and nothing else. */
export function writeEvent(event: CliEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

/**
 * One event read from stdin, written straight back to stdout: the operator's
 * terminal, or a harness standing in for a chat thread. The sender is the
 * local operator, who already holds the data directory and every credential
 * the run uses, so the sender check passes by construction. It shows no
 * status line: each tool call is a `step` line instead, and the reply is the
 * one message a run shows.
 */
export function createCliGateway(): Gateway {
  return {
    name: NAME,
    authorizeEffect: () => Effect.succeed(true),
    channel: () => ({
      brief: BRIEF,
      contextEffect: () => Effect.succeed(""),
      showEffect: (_marker, notice) =>
        Effect.sync(() => {
          if (notice.kind !== "reply") return
          writeEvent({ type: "reply", text: notice.text })
          writeEvent({
            type: "usage",
            inputTokens: notice.usage.inputTokens,
            outputTokens: notice.usage.outputTokens,
            costUsd: notice.usage.costUsd ?? null,
          })
        }),
      onToolStep: (step) =>
        writeEvent({ type: "step", tool: step.tool, write: step.write }),
      retractEffect: () => Effect.void,
    }),
  }
}

/**
 * The event on stdin as a message in its thread. A thread that has a
 * conversation already takes it as a follow-up, as a later message in a chat
 * thread is.
 */
export function readMessageEffect(
  threads: Pick<Threads, "sessionFile">,
): Effect.Effect<Inbound, Error> {
  return Effect.gen(function* () {
    const body = yield* storageIO(() => text(process.stdin))
    const value = yield* Effect.try({
      try: (): unknown => JSON.parse(body),
      catch: () => new Error(USAGE),
    })
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return yield* Effect.fail(new Error(USAGE))
    const unknown = Object.keys(value).filter(
      (key) => key !== "thread" && key !== "text",
    )
    if (unknown.length > 0)
      return yield* Effect.fail(
        new Error(`Unknown event field ${unknown.join(", ")}; ${USAGE}`),
      )
    const id = "thread" in value ? value.thread : undefined
    if (typeof id !== "string" || !THREAD_ID.test(id))
      return yield* Effect.fail(
        new Error(
          "thread must be 1 to 64 letters, digits, underscores, or hyphens",
        ),
      )
    const message = "text" in value ? value.text : undefined
    if (typeof message !== "string" || message.trim() === "")
      return yield* Effect.fail(new Error("text must be a non-empty string"))
    const thread = { gateway: NAME, id }
    const reply = yield* storageIO(() =>
      stat(threads.sessionFile(thread)),
    ).pipe(
      Effect.map((file) => file.isFile()),
      Effect.catch(() => Effect.succeed(false)),
    )
    return {
      thread,
      type: "MESSAGE",
      reply,
      title: undefined,
      text: message.trim(),
      source: null,
    }
  })
}
