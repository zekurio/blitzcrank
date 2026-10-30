import { Deferred, Effect, FiberSet, type Scope } from "effect"

import type { Gateway, GatewayHost, Intake } from "../../gateway.ts"
import { logEvent } from "../../log.ts"
import { loadChatConfig, type ChatConfig } from "../chat-config.ts"
import { createChatGateway, type Admitter } from "../chat-gateway.ts"
import type {
  ChatArrival,
  ChatClient,
  ChatError,
  ChatPlatform,
} from "../chat.ts"
import { StartupAudit } from "./audit.ts"
import {
  chatMessage,
  connectSocketEffect,
  discoverEffect,
  FluxerClient,
  FluxerError,
  THREAD_TYPES,
  type Dispatch,
} from "./client.ts"
import { decode, MessageCreate } from "./types.ts"

const PLATFORM: ChatPlatform = {
  name: "fluxer",
  title: "Fluxer",
  /** What a bot may post in one Fluxer message, at the least. */
  maxContent: 4_000,
  isError: (error): error is ChatError => error instanceof FluxerError,
}

export interface FluxerConfig extends ChatConfig {
  /**
   * The instance's web origin, such as https://fluxer.app, with no trailing
   * slash. Its discovery document names the API and gateway endpoints.
   */
  instance: string
}

export function loadFluxerConfig(): FluxerConfig {
  return { instance: instanceOrigin(), ...loadChatConfig(PLATFORM) }
}

/**
 * Only an origin: discovery lives at its root, and everything else comes
 * from there. The value is not echoed, since a URL can carry a password.
 */
function instanceOrigin(): string {
  const value = process.env.FLUXER_INSTANCE_URL?.trim()
  if (!value) {
    throw new Error(
      "FLUXER_INSTANCE_URL is required, e.g. https://fluxer.app or https://chat.example.com",
    )
  }
  const url = URL.parse(value)
  if (
    url === null ||
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "FLUXER_INSTANCE_URL must be an http(s) origin with no path, query, or credentials, e.g. https://fluxer.app",
    )
  }
  return url.origin
}

/** How long the guild burst after READY may take. */
const AUDIT_TIMEOUT = "30 seconds"

/** The dispatches the startup permission check reads. */
const AUDIT_EVENTS: ReadonlySet<string> = new Set([
  "READY",
  "GUILD_CREATE",
  "GUILD_DELETE",
])

/**
 * Fluxer threads as threads. A member's message in a watched channel opens
 * one when triage accepts it, a later message in it is a follow-up, and the
 * reply is a message the bot posts in it. REST needs the endpoints the
 * instance publishes, so it works once listening has discovered them; the
 * host listens before it recovers or runs anything.
 */
export function createFluxerGateway(
  config: FluxerConfig,
  host: GatewayHost,
): Gateway {
  // Listening completes this once discovery and the token check pass.
  const client = Deferred.makeUnsafe<ChatClient>()
  return createChatGateway(
    PLATFORM,
    config,
    host,
    Deferred.await(client),
    (intake, admitter) => listenEffect(config, client, intake, admitter),
  )
}

function listenEffect(
  config: FluxerConfig,
  client: Deferred.Deferred<ChatClient>,
  intake: Intake,
  admitter: Admitter,
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
    const admit = admitter(fluxer, botId)
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
      run(admit(chatArrival(message)))
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
