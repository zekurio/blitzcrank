import path from "node:path"

import type { Effect } from "effect"

import { CaseStore } from "./casefile.ts"
import type { JsonValue } from "./services/http.ts"

/**
 * A gateway is the only part of the host that knows where requests come from
 * and where answers go. It turns inbound traffic into events on a thread and
 * gives a run a channel back to that thread. The queue, the journal, and the
 * agent loop see threads, never the system behind them.
 */

/** One conversation a gateway owns, such as a Seerr issue. */
export interface ThreadRef {
  gateway: string
  /** Names the thread's files: letters, digits, `_`, and `-` only. */
  id: string
}

/** A message a gateway accepted for a thread. Its text is untrusted. */
export interface Inbound {
  thread: ThreadRef
  /** The gateway's own name for the event, shown to the model. */
  type: string
  /** A later message in a thread, not the one that opened it. */
  reply: boolean
  title: string | undefined
  text: string | undefined
  /** For the gateway alone, to authorize the message again after a restart. */
  source: JsonValue
}

export type ThreadEvent =
  | ({ kind: "message" } & Inbound)
  | { kind: "revisit"; thread: ThreadRef; reason: string }

/**
 * Every signature the host writes starts with this, so a gateway can tell
 * the host's own messages from a person's.
 */
export const SIGNATURE_PREFIX = "[blitzcrank w/"

/** One string per thread, for timers, locks, and log lines. */
export function threadKey(thread: ThreadRef): string {
  return `${thread.gateway}:${thread.id}`
}

/** A gateway's handle on the one message a run shows in its thread. */
export interface Marker {
  id: string | number | undefined
}

export interface Notice {
  text: string
  /** Host-written footer naming the model. A gateway decides how to show it. */
  signature: string
}

/** Everything a run may do to the outside of one thread. */
export interface Channel {
  /** The thread as it is now, for the prompt. Untrusted content. */
  contextEffect(): Effect.Effect<string, unknown>
  /** Posts the run's one visible message, or rewrites it in place. */
  showEffect(marker: Marker, notice: Notice): Effect.Effect<void, unknown>
  /** Removes that message, if there is one. */
  retractEffect(marker: Marker): Effect.Effect<void, unknown>
  /**
   * Present when the agent may close the thread. The host builds the tool,
   * which only records the request, and runs `effect` after the reply is out.
   */
  close?: {
    tool: string
    description: string
    effect(): Effect.Effect<void, unknown>
  }
}

/** What a gateway may ask of the host. */
export interface Intake {
  submit(message: Inbound): Effect.Effect<"paused" | "queued", unknown>
  stop(thread: ThreadRef): Effect.Effect<void, unknown>
  resume(thread: ThreadRef): Effect.Effect<void, unknown>
  /** The thread was closed from outside, so its pending revisit is dropped. */
  closed(thread: ThreadRef): Effect.Effect<void, unknown>
}

export interface Gateway {
  /** Routes `POST /webhook/<name>` and tags this gateway's threads. */
  readonly name: string
  /** For the system prompt: where messages come from and where a reply goes. */
  readonly brief: string
  /** Where its threads keep case files and sessions, below the data dir. */
  readonly storage: { cases: string; sessions: string }
  /** Checked before a webhook body is read. */
  authorized(authorization: string | undefined): boolean
  /** Handles one webhook body and returns the JSON to answer with. */
  webhookEffect(
    body: unknown,
    intake: Intake,
  ): Effect.Effect<Record<string, JsonValue>, unknown>
  /** Whether an accepted event may still run after a restart. */
  authorizeEffect(event: ThreadEvent): Effect.Effect<boolean, unknown>
  channel(threadId: string): Channel
}

/** Where one gateway's threads keep their case files and sessions. */
export interface ThreadDirs {
  cases: string
  sessions: string
}

/** The host's gateways by name, each with its own storage. */
export class Gateways {
  private readonly entries: Map<
    string,
    { gateway: Gateway; cases: CaseStore; dirs: ThreadDirs }
  >

  constructor(dataDir: string, gateways: readonly Gateway[]) {
    this.entries = new Map(
      gateways.map((gateway) => {
        const dirs = {
          cases: path.join(dataDir, gateway.storage.cases),
          sessions: path.join(dataDir, gateway.storage.sessions),
        }
        return [
          gateway.name,
          { gateway, cases: new CaseStore(dirs.cases), dirs },
        ]
      }),
    )
  }

  find(name: string): Gateway | undefined {
    return this.entries.get(name)?.gateway
  }

  of(thread: ThreadRef): Gateway {
    return this.entry(thread).gateway
  }

  cases(thread: ThreadRef): CaseStore {
    return this.entry(thread).cases
  }

  dirs(thread: ThreadRef): ThreadDirs {
    return this.entry(thread).dirs
  }

  sessionFile(thread: ThreadRef): string {
    return path.join(
      this.entry(thread).dirs.sessions,
      `${encodeURIComponent(thread.id)}.sqlite`,
    )
  }

  /** Every gateway's case store, for re-arming revisits after a restart. */
  stores(): { gateway: string; cases: CaseStore }[] {
    return [...this.entries].map(([gateway, entry]) => ({
      gateway,
      cases: entry.cases,
    }))
  }

  private entry(thread: ThreadRef) {
    const entry = this.entries.get(thread.gateway)
    if (!entry) throw new Error(`Unknown gateway ${thread.gateway}`)
    return entry
  }
}
