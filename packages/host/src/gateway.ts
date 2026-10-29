import path from "node:path"

import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { Effect, type Scope } from "effect"

import type { ThreadUsage, ToolStep } from "./agent/session.ts"
import type { Helper } from "./helper.ts"
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
  /**
   * Whether the gateway's sender check found this message's sender an admin,
   * who may have media removed that plays fine. It holds for this message
   * alone. Recovery keeps it only if the gateway finds them one again.
   */
  admin: boolean
  /** For the gateway alone, to authorize the message again after a restart. */
  source: JsonValue
}

/**
 * What a gateway's sender check makes of a message's sender. An admin is a
 * member too.
 */
export type Access = "denied" | "member" | "admin"

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

/** A status line the reply later replaces, or the reply itself. */
export type Notice =
  | (NoticeText & { kind: "status" })
  | (NoticeText & {
      kind: "reply"
      /** The thread's totals the signature sums up, for a gateway that shows them itself. */
      usage: ThreadUsage
    })

interface NoticeText {
  text: string
  /** Host-written footer naming the model. A gateway decides how to show it. */
  signature: string
}

/**
 * Everything a run may do to the outside of one thread. It cannot close one:
 * not every gateway has a closed state, so that stays with the people in it.
 */
export interface Channel {
  /**
   * For the system prompt: where messages come from, where a reply goes, and
   * what the thread leaves to the reporter.
   */
  readonly brief: string
  /** The thread as it is now, for the prompt. Untrusted content. */
  contextEffect(): Effect.Effect<string, unknown>
  /** Posts the run's one visible message, or rewrites it in place. */
  showEffect(marker: Marker, notice: Notice): Effect.Effect<void, unknown>
  /**
   * Rewrites the status line with the step a run is taking, from host text
   * alone. It never posts: without a shown message it does nothing. The host
   * stops calling it before the reply or a retraction. A gateway without it
   * shows no live status.
   */
  progressEffect?(marker: Marker, text: string): Effect.Effect<void, unknown>
  /**
   * Hears every tool call a run starts, never one replayed from the journal,
   * by the tool's name and whether it may write: nothing the model passed to
   * it. It runs inside the call, so it must return at once. A gateway
   * without it hears none.
   */
  readonly onToolStep?: (step: ToolStep) => void
  /** Removes that message, if there is one. */
  retractEffect(marker: Marker): Effect.Effect<void, unknown>
}

/** What a gateway may ask of the host. */
export interface Intake {
  /**
   * Succeeds once recovered work is queued and shutdown owns admission. A
   * gateway that listens may connect before then, but acts on nothing it
   * hears until this succeeds. A webhook needs no wait: the host serves HTTP
   * only after recovery.
   */
  readonly opened: Effect.Effect<void>
  submit(message: Inbound): Effect.Effect<"cancelling" | "queued", unknown>
  /**
   * Reports that a gateway that listens has lost its platform for good, such
   * as when the platform rejects a token that was regenerated. The host then
   * shuts down as it does on a signal, but exits with a failure so the
   * service manager restarts it. A report made during startup is acted on
   * once shutdown is in place; one during a shutdown already underway
   * changes nothing.
   */
  lost(error: Error): Effect.Effect<void>
}

/** What a gateway may take from the host when it is built. */
export interface GatewayHost {
  runtime: ModelRuntime
  /** The configured language, for the lines a gateway posts itself. */
  language: string
  /** The helper model, when `BLITZCRANK_HELPER_MODEL` names one. */
  helper: Helper | undefined
}

/** A gateway's endpoint at `POST /webhook/<name>`, for a platform that calls the host. */
export interface Webhook {
  /** Checked before the body is read. */
  authorized(authorization: string | undefined): boolean
  /** Handles one body and returns the JSON to answer with. */
  handleEffect(
    body: unknown,
    intake: Intake,
  ): Effect.Effect<Record<string, JsonValue>, unknown>
}

export interface Gateway {
  /**
   * Tags this gateway's threads, names the directory their conversations are
   * kept in, and routes its webhook.
   */
  readonly name: string
  readonly webhook?: Webhook
  /**
   * For a platform the host connects to. Opens that connection and returns
   * once it is listening, which can be before `intake.opened` succeeds; what
   * arrives waits for that before anything acts on it. A connection lost for
   * good before it is listening fails this; one lost later goes to
   * `intake.lost`.
   * Closing the scope stops admission only: runs still drain through
   * `channel` after it closes.
   */
  listenEffect?(intake: Intake): Effect.Effect<void, unknown, Scope.Scope>
  /**
   * Checks an accepted message's sender again after a restart, as admission
   * did. A check that cannot run never finds an admin.
   */
  authorizeEffect(message: Inbound): Effect.Effect<Access, unknown>
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
    if (!gateway) throw new Error(`Gateway ${thread.gateway} is not enabled`)
    return gateway
  }

  /**
   * Connects every gateway that listens, in the caller's scope. Their
   * admission waits for `intake.opened`.
   */
  listenEffect(intake: Intake): Effect.Effect<void, unknown, Scope.Scope> {
    return Effect.forEach(
      this.entries.values(),
      (gateway) => gateway.listenEffect?.(intake) ?? Effect.void,
      { discard: true },
    )
  }

  channel(thread: ThreadRef): Channel {
    return this.of(thread).channel(thread.id)
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

/**
 * All a run is handed of the gateways: its thread's channel and where the
 * thread's conversation is kept. Intake, listening, and authorization stay out
 * of reach.
 */
export type Threads = Pick<Gateways, "channel" | "sessionFile" | "sessionsDir">
