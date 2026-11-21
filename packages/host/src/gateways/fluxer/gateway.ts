import { Cause, Deferred, Effect, FiberSet, type Scope } from "effect"

import { outOfScopeMessage } from "../../agent/notices.ts"
import type {
  Access,
  Gateway,
  GatewayHost,
  Inbound,
  Intake,
  Marker,
  Notice,
} from "../../gateway.ts"
import type { Helper } from "../../helper.ts"
import { errorKind, logEvent } from "../../log.ts"
import type { JsonValue } from "../../services/http.ts"
import {
  admitEffect,
  memberAccessEffect,
  NAME,
  Places,
  type ChatSource,
} from "./admission.ts"
import { StartupAudit } from "./audit.ts"
import { fit, MAX_CONTENT, type ChatArrival } from "./chat.ts"
import {
  chatMessage,
  connectSocketEffect,
  discoverEffect,
  FluxerClient,
  type FluxerError,
  THREAD_TYPES,
  type Dispatch,
} from "./client.ts"
import type { FluxerConfig } from "./config.ts"
import { contextEffect } from "./context.ts"
import { createTriage, type Triage } from "./triage.ts"
import { decode, MessageCreate } from "./types.ts"

/** How long the guild burst after READY may take. */
const AUDIT_TIMEOUT = "30 seconds"

/** The dispatches the startup permission check reads. */
const AUDIT_EVENTS: ReadonlySet<string> = new Set([
  "READY",
  "GUILD_CREATE",
  "GUILD_DELETE",
])

const BRIEF =
  "Each conversation is one Fluxer thread the bot opened from a member's message in a homelab help channel. " +
  "Every event comes with the thread's opening message, when it is still in reach, and its latest messages from members allowed to use the bot. " +
  "Other people's and bots' messages are omitted; your prior replies are in this conversation. Your final message is posted in the thread. " +
  "Keep it under 1,500 characters; longer replies are cut. Members answer by writing in the thread. " +
  "A member is known only by their Fluxer name, which identifies no Matinee account; never match one by name."

/** What admission takes from the host, beside the connection itself. */
interface Admission {
  triage: Triage
  /** Names the threads admission opens. */
  helper: Helper
  /** The fixed line a turned-away mention gets. */
  denial: string
}

/**
 * Fluxer threads as threads. A member's message in a watched channel opens
 * one when triage accepts it, a later message in it is a follow-up, and the
 * reply is a message the bot posts in it. Recovery's sender check and a run's
 * channel read and write over REST alone, so they work while runs drain
 * after the socket closes. REST needs the endpoints the instance publishes,
 * so it works once listening has discovered them; the host listens before it
 * recovers or runs anything. Triage is resolved here, at startup.
 */
export function createFluxerGateway(
  config: FluxerConfig,
  host: GatewayHost,
): Gateway {
  const admission: Admission = {
    triage: createTriage(host.runtime, config.triageModel),
    helper: host.helper,
    denial: outOfScopeMessage(host.language),
  }
  // Listening completes this once discovery and the token check pass.
  const connected = Deferred.makeUnsafe<FluxerClient>()
  const client = Deferred.await(connected)
  return {
    name: NAME,
    listenEffect: (intake) =>
      listenEffect(config, connected, intake, admission),
    // Allowlists and watched channels may have changed while the host was
    // down, and a member may have left or lost the role that admitted them
    // or made them an admin.
    authorizeEffect: (message) => authorizeEffect(config, client, message),
    channel: (threadId) => ({
      brief: BRIEF,
      contextEffect: () =>
        client.pipe(
          Effect.flatMap((fluxer) => contextEffect(config, fluxer, threadId)),
        ),
      showEffect: (marker, notice) =>
        client.pipe(
          Effect.flatMap((fluxer) =>
            showEffect(fluxer, threadId, marker, notice),
          ),
        ),
      progressEffect: (marker, text) => {
        const id = marker.id
        if (typeof id !== "string") return Effect.void
        return client.pipe(
          Effect.flatMap((fluxer) =>
            fluxer.editEffect(threadId, id, fit(text, MAX_CONTENT)),
          ),
        )
      },
      retractEffect: (marker) => {
        const id = marker.id
        if (typeof id !== "string") return Effect.void
        return client.pipe(
          Effect.flatMap((fluxer) => fluxer.deleteEffect(threadId, id)),
        )
      },
    }),
  }
}

function listenEffect(
  config: FluxerConfig,
  connected: Deferred.Deferred<FluxerClient>,
  intake: Intake,
  admission: Admission,
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
    yield* Deferred.succeed(connected, fluxer)
    const botId = application.id
    const deps = {
      ...admission,
      config,
      client: fluxer,
      places: new Places(fluxer, config.channels, botId),
      intake,
      botId,
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
      run(admitEffect(chatArrival(message), deps))
    }
    // Succeeds once READY reached the audit; the guild burst follows it. A
    // socket Fluxer closes for good after that stops the host.
    yield* connectSocketEffect(endpoints, config.token, onDispatch, (error) =>
      intake.lost(error),
    )
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

/** Fluxer sends every message's channel type, so only a thread costs a lookup. */
function chatArrival(message: MessageCreate): ChatArrival {
  return {
    ...chatMessage(message),
    channelId: message.channel_id,
    inThread: THREAD_TYPES.has(message.channel_type),
    guildId: message.guild_id,
    member: message.member,
  }
}

function authorizeEffect(
  config: FluxerConfig,
  client: Effect.Effect<FluxerClient>,
  message: Inbound,
): Effect.Effect<Access> {
  const source = sourceOf(message.source)
  if (source === undefined || !config.channels.has(source.parent)) {
    logEvent("fluxer.denied", { reason: "channel_not_watched" }, "warn")
    return Effect.succeed("denied")
  }
  return client.pipe(
    Effect.flatMap((fluxer) =>
      memberAccessEffect(fluxer, config, source.guild, source.author),
    ),
    Effect.tap((access) =>
      Effect.sync(() => {
        if (access === "denied")
          logEvent("fluxer.denied", { reason: "not_allowed" }, "warn")
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
      return Effect.succeed<Access>("denied")
    }),
  )
}

/** The source this gateway stored, or nothing if it is not one. */
function sourceOf(value: JsonValue): ChatSource | undefined {
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
    return fluxer.editEffect(threadId, marker.id, content)
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
 * The text cut to fit one message. Only a reply carries the model footer: a
 * status line is short and soon replaced, and chat tells the bot's own
 * messages apart by author, not by footer.
 */
function messageContent(notice: Notice): string {
  if (notice.kind === "status") return fit(notice.text, MAX_CONTENT)
  const footer = `\n\n-# ${notice.signature}`
  return `${fit(notice.text, MAX_CONTENT - footer.length)}${footer}`
}
