import path from "node:path"

import type { Effect } from "effect"

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

/**
 * Every signature the host writes starts with this, so a gateway can tell
 * the host's own messages from a person's.
 */
export const SIGNATURE_PREFIX = "[blitzcrank w/"

/** One string per thread, for the queue and log lines. */
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

/**
 * Everything a run may do to the outside of one thread. It cannot close one:
 * not every gateway has a closed state, so that stays with the people in it.
 */
export interface Channel {
  /** The thread as it is now, for the prompt. Untrusted content. */
  contextEffect(): Effect.Effect<string, unknown>
  /** Posts the run's one visible message, or rewrites it in place. */
  showEffect(marker: Marker, notice: Notice): Effect.Effect<void, unknown>
  /** Removes that message, if there is one. */
  retractEffect(marker: Marker): Effect.Effect<void, unknown>
}

/** What a gateway may ask of the host. */
export interface Intake {
  submit(message: Inbound): Effect.Effect<"cancelling" | "queued", unknown>
}

export interface Gateway {
  /**
   * Routes `POST /webhook/<name>`, tags this gateway's threads, and names the
   * directory their conversations are kept in.
   */
  readonly name: string
  /**
   * For the system prompt: where messages come from, where a reply goes, and
   * what the thread leaves to the reporter.
   */
  readonly brief: string
  /** Checked before a webhook body is read. */
  authorized(authorization: string | undefined): boolean
  /** Handles one webhook body and returns the JSON to answer with. */
  webhookEffect(
    body: unknown,
    intake: Intake,
  ): Effect.Effect<Record<string, JsonValue>, unknown>
  /** Whether an accepted message may still run after a restart. */
  authorizeEffect(message: Inbound): Effect.Effect<boolean, unknown>
  channel(threadId: string): Channel
}

/** The host's gateways by name, each with its own directory of conversations. */
export class Gateways {
  private readonly entries: Map<string, Gateway>

  constructor(
    private readonly dataDir: string,
    gateways: readonly Gateway[],
  ) {
    this.entries = new Map(gateways.map((gateway) => [gateway.name, gateway]))
  }

  find(name: string): Gateway | undefined {
    return this.entries.get(name)
  }

  of(thread: ThreadRef): Gateway {
    const gateway = this.entries.get(thread.gateway)
    if (!gateway) throw new Error(`Unknown gateway ${thread.gateway}`)
    return gateway
  }

  /** The directory holding every conversation of this thread's gateway. */
  sessionsDir(thread: ThreadRef): string {
    return path.join(this.dataDir, "sessions", this.of(thread).name)
  }

  sessionFile(thread: ThreadRef): string {
    return path.join(
      this.sessionsDir(thread),
      `${encodeURIComponent(thread.id)}.sqlite`,
    )
  }
}
