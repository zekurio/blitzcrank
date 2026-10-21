import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { Cause, Deferred, Effect, FiberSet, type Scope } from "effect"

import { outOfScopeMessage } from "../../agent/notices.ts"
import type {
  Channel,
  Gateway,
  Inbound,
  Marker,
  Notice,
} from "../../gateway.ts"
import { errorKind, logEvent } from "../../log.ts"
import type { JsonValue } from "../../services/http.ts"
import { toText } from "../../tools/common.ts"
import { fit, messageText } from "../chat.ts"
import { createTriage } from "../triage.ts"
import {
  admitEffect,
  memberAllowedEffect,
  NAME,
  Places,
  type AdmissionDeps,
  type FluxerSource,
} from "./admission.ts"
import { StartupAudit } from "./audit.ts"
import {
  connectSocketEffect,
  discoverEffect,
  FluxerClient,
  type Dispatch,
  type FluxerError,
} from "./client.ts"
import type { FluxerConfig } from "./config.ts"
import {
  decode,
  MessageCreate,
  MessageType,
  type Message,
  type ReferencedMessage,
} from "./types.ts"

const BRIEF =
  "Each conversation is one Fluxer thread the bot opened from a member's message in a homelab help channel. " +
  "Every event comes with the thread's opening message, when it is still in reach, and its latest messages from members allowed to use the bot. " +
  "Other people's and bots' messages are omitted; your prior replies are in this conversation. Your final message is posted in the thread. " +
  "Keep it under 1,500 characters; longer replies are cut. Members answer by writing in the thread. " +
  "A member is known only by their Fluxer name, which identifies no Seerr or Jellyfin account; never match one by name."

/** What a bot may post in one Fluxer message, at the least. */
const MAX_CONTENT = 4_000
const CONTEXT_SCAN = 50
const MAX_CONTEXT_MESSAGES = 5
const MAX_CONTEXT_CHARS = 1_000
/** Membership lookups in flight for one context. */
const CONTEXT_LOOKUPS = 4
/** How long the guild burst after READY may take. */
const AUDIT_TIMEOUT = "30 seconds"
/**
 * How long recovery or a run waits for listening to make REST usable. The
 * host listens before either, so this only bounds a broken startup.
 */
const CLIENT_TIMEOUT = "60 seconds"

/** The dispatches the startup permission check reads. */
const AUDIT_EVENTS: ReadonlySet<string> = new Set([
  "READY",
  "GUILD_CREATE",
  "GUILD_DELETE",
])

export interface FluxerHost {
  runtime: ModelRuntime
  language: string
}

/**
 * Fluxer threads as threads. A member's message in a watched channel opens
 * one when triage accepts it, a later message in it is a follow-up, and the
 * reply is a message the bot posts in it. REST needs the endpoints the
 * instance publishes, so it works once listening has discovered them; the
 * host listens before it recovers or runs anything.
 */
export function createFluxerGateway(
  config: FluxerConfig,
  host: FluxerHost,
): Gateway {
  const triage = createTriage(host.runtime, config.triageModel, {
    setting: "FLUXER_TRIAGE_MODEL",
    platform: "Fluxer",
  })
  const denial = outOfScopeMessage(host.language)
  // Listening completes this once discovery and the token check pass.
  const client = Deferred.makeUnsafe<FluxerClient>()
  const clientEffect: Effect.Effect<FluxerClient, Error> = Deferred.await(
    client,
  ).pipe(
    Effect.timeoutOrElse({
      duration: CLIENT_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new Error(`Fluxer REST was not ready within ${CLIENT_TIMEOUT}`),
        ),
    }),
  )

  const channel = (threadId: string): Channel => ({
    brief: BRIEF,
    contextEffect: () =>
      clientEffect.pipe(
        Effect.flatMap((fluxer) => contextEffect(config, fluxer, threadId)),
      ),
    showEffect: (marker, notice) =>
      clientEffect.pipe(
        Effect.flatMap((fluxer) =>
          showEffect(fluxer, threadId, marker, notice),
        ),
      ),
    retractEffect: (marker) => {
      const id = marker.id
      if (typeof id !== "string") return Effect.void
      return clientEffect.pipe(
        Effect.flatMap((fluxer) => fluxer.deleteEffect(threadId, id)),
      )
    },
  })

  return {
    name: NAME,
    listenEffect: (intake) =>
      listenEffect(config, client, { triage, denial, intake }),
    // Allowlists and watched channels may have changed while the host was
    // down, and a member may have left or lost the role that admitted them.
    authorizeEffect: (message) =>
      authorizeEffect(config, clientEffect, message),
    channel,
  }
}

function listenEffect(
  config: FluxerConfig,
  client: Deferred.Deferred<FluxerClient>,
  deps: Pick<AdmissionDeps, "triage" | "denial" | "intake">,
): Effect.Effect<void, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    const endpoints = yield* discoverEffect(config.instance).pipe(
      Effect.mapError(
        (error) =>
          new Error(
            `The instance at FLUXER_INSTANCE_URL is unreachable or not a Fluxer instance (status ${error.status ?? "none"}, code ${error.code ?? "none"})`,
          ),
      ),
    )
    const fluxer = new FluxerClient(endpoints, config.token)
    // Also checks the token before the socket opens. The bot user is the
    // application, so they share an id.
    const application = yield* fluxer
      .currentApplicationEffect()
      .pipe(
        Effect.mapError(
          (error) =>
            new Error(
              error.status === 401
                ? "Fluxer rejected FLUXER_BOT_TOKEN"
                : `Fluxer API is unreachable (status ${error.status ?? "none"})`,
            ),
        ),
      )
    yield* Deferred.succeed(client, fluxer)
    const botId = application.id
    const admission: AdmissionDeps = {
      ...deps,
      config,
      fluxer,
      botId,
      places: new Places(fluxer, config.channels, botId),
    }
    // Made before the socket, so closing the scope stops the socket first
    // and then interrupts admissions in flight, except one that is opening a
    // thread, which finishes.
    const handlers = yield* FiberSet.make()
    const run = yield* FiberSet.runtime(handlers)()
    const audit = new StartupAudit(config.channels, botId)
    const audited = yield* Deferred.make<number, Error>()
    // The socket calls this in order and cannot await. The fiber set owns
    // each admission; the audit only records.
    const onDispatch = (event: Dispatch): void => {
      if (AUDIT_EVENTS.has(event.t)) {
        const verdict = audit.feed(event)
        if (verdict !== undefined)
          Deferred.doneUnsafe(
            audited,
            verdict.ok
              ? Effect.succeed(verdict.guilds)
              : Effect.fail(verdict.error),
          )
        return
      }
      if (event.t !== "MESSAGE_CREATE") return
      const message = decode(MessageCreate, event.d)
      if (message === undefined) {
        logEvent(
          "fluxer.event_dropped",
          { t: event.t, reason: "malformed" },
          "warn",
        )
        return
      }
      run(admitEffect(message, admission))
    }
    // Succeeds once READY reached the audit; the guild burst follows it.
    yield* connectSocketEffect(endpoints, config.token, onDispatch)
    const guilds = yield* Deferred.await(audited).pipe(
      Effect.timeoutOrElse({
        duration: AUDIT_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new Error(
              `Fluxer sent no state for guild ${audit.pending().join(", ")} within ${AUDIT_TIMEOUT} of READY, so the bot's permissions could not be checked`,
            ),
          ),
      }),
    )
    logEvent("fluxer.listening", { channels: config.channels.size, guilds })
  })
}

function authorizeEffect(
  config: FluxerConfig,
  clientEffect: Effect.Effect<FluxerClient, Error>,
  message: Inbound,
): Effect.Effect<boolean> {
  const source = sourceOf(message.source)
  if (source === undefined || !config.channels.has(source.parent)) {
    logEvent("fluxer.denied", { reason: "channel_not_watched" }, "warn")
    return Effect.succeed(false)
  }
  return clientEffect.pipe(
    Effect.flatMap((fluxer) =>
      memberAllowedEffect(fluxer, config, source.guild, source.author),
    ),
    Effect.tap((ok) =>
      Effect.sync(() => {
        if (!ok) logEvent("fluxer.denied", { reason: "not_allowed" }, "warn")
      }),
    ),
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.interrupt
      logEvent(
        "fluxer.denied",
        {
          reason: "authorization_unavailable",
          error: errorKind(Cause.squash(cause)),
        },
        "warn",
      )
      return Effect.succeed(false)
    }),
  )
}

/** The source this gateway stored, or nothing if it is not one. */
function sourceOf(value: JsonValue): FluxerSource | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined
  const guild = value.guild
  const parent = value.parent
  const author = value.author
  if (
    typeof guild !== "string" ||
    typeof parent !== "string" ||
    typeof author !== "string"
  )
    return undefined
  return { guild, parent, author }
}

function showEffect(
  fluxer: FluxerClient,
  threadId: string,
  marker: Marker,
  notice: Notice,
): Effect.Effect<void, FluxerError> {
  const content = messageContent(notice)
  if (typeof marker.id === "string")
    return fluxer.editEffect(threadId, marker.id, content).pipe(Effect.asVoid)
  return fluxer.postEffect(threadId, content).pipe(
    Effect.tap((posted) =>
      Effect.sync(() => {
        marker.id = posted.id
      }),
    ),
    Effect.asVoid,
  )
}

/**
 * The thread for the prompt, with only allowed members' text in it. Anyone can
 * write in a public thread, and a stranger admission turned away must not
 * steer a run through its context instead. It reads REST alone, so it works
 * while runs drain after the socket closes.
 */
function contextEffect(
  config: FluxerConfig,
  fluxer: FluxerClient,
  threadId: string,
): Effect.Effect<string, FluxerError | Error> {
  return Effect.gen(function* () {
    const thread = yield* fluxer.channelEffect(threadId)
    const guild = thread.guild_id
    if (guild === undefined)
      return yield* Effect.fail(new Error("Fluxer thread has no guild"))
    const newestFirst = yield* fluxer.recentMessagesEffect(
      threadId,
      CONTEXT_SCAN,
    )
    const opener = openerOf(newestFirst)
    const authors = new Set(
      [...newestFirst, ...(opener ? [opener] : [])]
        .filter(byPerson)
        .map((message) => message.author.id),
    )
    // Asked again on every run, so someone who left or lost a role since the
    // last one drops out.
    const permitted = new Set(
      yield* Effect.filter(
        authors,
        (author) => memberAllowedEffect(fluxer, config, guild, author),
        { concurrency: CONTEXT_LOOKUPS },
      ),
    )
    return `Current Fluxer thread (untrusted content):\n${toText(threadContext(newestFirst, opener, permitted))}`
  })
}

/** The message the thread was opened from, when its starter is in reach. */
function openerOf(newestFirst: readonly Message[]) {
  return newestFirst.find(
    (message) => message.type === MessageType.ThreadStarterMessage,
  )?.referenced_message
}

/** Written by a person, as admission takes one. */
function byPerson(message: ReferencedMessage): boolean {
  return (
    !message.author.bot &&
    typeof message.webhook_id !== "string" &&
    (message.type === MessageType.Default || message.type === MessageType.Reply)
  )
}

/** Allowed members' messages only, oldest first, never Fluxer's user records. */
function threadContext(
  newestFirst: readonly Message[],
  opener: ReferencedMessage | null | undefined,
  permitted: ReadonlySet<string>,
) {
  const counts = (message: ReferencedMessage) =>
    byPerson(message) && permitted.has(message.author.id)
  const recent = newestFirst
    .filter(counts)
    .slice(0, MAX_CONTEXT_MESSAGES)
    .toReversed()
  return {
    ...(opener && counts(opener) ? { opener: contextEntry(opener) } : {}),
    recent: recent.map(contextEntry),
  }
}

function contextEntry(message: ReferencedMessage) {
  const text = messageText(message.content, message.mentions, undefined)
  return {
    author: message.author.global_name ?? message.author.username,
    at: message.timestamp,
    message: text.slice(0, MAX_CONTEXT_CHARS),
    ...(text.length > MAX_CONTEXT_CHARS ? { truncated: true } : {}),
  }
}

/** The reply and its signature, cut to fit one Fluxer message. */
function messageContent(notice: Notice): string {
  const footer = `\n\n-# ${notice.signature}`
  return `${fit(notice.text, MAX_CONTENT - footer.length)}${footer}`
}
