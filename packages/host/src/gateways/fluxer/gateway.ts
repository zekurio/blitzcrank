import { Deferred, Effect, FiberSet, type Scope } from "effect"

import { outOfScopeMessage } from "../../agent/notices.ts"
import type { Gateway, GatewayHost } from "../../gateway.ts"
import { logEvent } from "../../log.ts"
import { admitEffect, Places, type AdmissionDeps } from "../chat-admission.ts"
import { createChatGateway } from "../chat-gateway.ts"
import {
  chatClient,
  type ChatArrival,
  type ChatChannel,
  type ChatClient,
  type ChatError,
  type ChatMessage,
  type ChatPlatform,
  type MessageKind,
} from "../chat.ts"
import { createTriage } from "../triage.ts"
import { StartupAudit } from "./audit.ts"
import {
  connectSocketEffect,
  discoverEffect,
  FluxerClient,
  FluxerError,
  type Dispatch,
} from "./client.ts"
import type { FluxerConfig } from "./config.ts"
import {
  ChannelType,
  decode,
  MessageCreate,
  MessageType,
  type Channel,
  type Message,
} from "./types.ts"

const PLATFORM: ChatPlatform = {
  name: "fluxer",
  title: "Fluxer",
  /** What a bot may post in one Fluxer message, at the least. */
  maxContent: 4_000,
  isError: (error): error is ChatError => error instanceof FluxerError,
}

/** How long the guild burst after READY may take. */
const AUDIT_TIMEOUT = "30 seconds"

/** The dispatches the startup permission check reads. */
const AUDIT_EVENTS: ReadonlySet<string> = new Set([
  "READY",
  "GUILD_CREATE",
  "GUILD_DELETE",
])

const THREAD_TYPES: ReadonlySet<number> = new Set([
  ChannelType.AnnouncementThread,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
])

const MESSAGE_KINDS: ReadonlyMap<number, MessageKind> = new Map([
  [MessageType.Default, "default"],
  [MessageType.Reply, "reply"],
  [MessageType.ThreadStarterMessage, "thread_starter"],
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
  const triage = createTriage(host.runtime, config.triageModel, {
    setting: "FLUXER_TRIAGE_MODEL",
    platform: PLATFORM.title,
  })
  const denial = outOfScopeMessage(host.language)
  // Listening completes this once discovery and the token check pass.
  const client = Deferred.makeUnsafe<ChatClient>()
  return createChatGateway(PLATFORM, config, Deferred.await(client), (intake) =>
    listenEffect(config, client, { triage, denial, intake }),
  )
}

function listenEffect(
  config: FluxerConfig,
  client: Deferred.Deferred<ChatClient>,
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
    const chat = chatClient(fluxer, chatMessage, chatChannel)
    yield* Deferred.succeed(client, chat)
    const botId = application.id
    const admission: AdmissionDeps = {
      ...deps,
      platform: PLATFORM,
      config,
      client: chat,
      botId,
      places: new Places(chat, config.channels, botId),
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
      run(admitEffect(chatArrival(message), admission))
    }
    // Succeeds once READY reached the audit; the guild burst follows it. A
    // socket Fluxer closes for good after that stops the host.
    yield* connectSocketEffect(endpoints, config.token, onDispatch, (error) =>
      deps.intake.lost(error),
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

function chatMessage(message: Message): ChatMessage {
  return {
    id: message.id,
    author: message.author,
    // Null on the starter message Fluxer builds for a thread.
    webhook: typeof message.webhook_id === "string",
    kind: MESSAGE_KINDS.get(message.type) ?? "other",
    content: message.content,
    mentions: message.mentions,
    timestamp: message.timestamp,
    referenced: message.referenced_message
      ? chatMessage(message.referenced_message)
      : undefined,
  }
}

function chatChannel(channel: Channel): ChatChannel {
  return {
    thread: THREAD_TYPES.has(channel.type),
    guildId: channel.guild_id,
    parentId: channel.parent_id ?? undefined,
    ownerId: channel.owner_id ?? undefined,
  }
}
