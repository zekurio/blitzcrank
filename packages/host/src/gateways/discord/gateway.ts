import {
  Client,
  GatewayCloseCodes,
  GatewayDispatchEvents,
  GatewayIntentBits,
  type GatewayMessageCreateDispatchData,
} from "@discordjs/core"
import { WebSocketManager, WebSocketShardEvents } from "@discordjs/ws"
import {
  Cause,
  Deferred,
  Effect,
  FiberSet,
  Latch,
  Option,
  type Scope,
} from "effect"

import type { Gateway, GatewayHost } from "../../gateway.ts"
import { errorKind, logEvent } from "../../log.ts"
import { loadChatConfig, type ChatConfig } from "../chat-config.ts"
import { createChatGateway, type Admitter } from "../chat-gateway.ts"
import type { ChatArrival, ChatError, ChatPlatform } from "../chat.ts"
import {
  chatMessage,
  DiscordClient,
  DiscordError,
  THREAD_TYPES,
} from "./client.ts"

const PLATFORM: ChatPlatform = {
  name: "discord",
  title: "Discord",
  /** Discord's limit for a message's content. */
  maxContent: 2_000,
  isError: (error): error is ChatError => error instanceof DiscordError,
}

export function loadDiscordConfig(): ChatConfig {
  return loadChatConfig(PLATFORM)
}

/** Message content needs a privileged intent, set in the developer portal. */
const INTENTS =
  GatewayIntentBits.GuildMessages | GatewayIntentBits.MessageContent

const READY_TIMEOUT = "60 seconds"
const CLOSE_TIMEOUT = "5 seconds"

/**
 * The close codes `@discordjs/ws` 2.0.4 never reconnects after, each with
 * the error that stops the host. The shard stays closed, and only an error
 * event says so.
 */
const FATAL_CLOSES: ReadonlyMap<number, string> = new Map([
  [
    GatewayCloseCodes.AuthenticationFailed,
    "Discord rejected DISCORD_BOT_TOKEN",
  ],
  [GatewayCloseCodes.InvalidShard, "Discord gateway closed: invalid shard"],
  [
    GatewayCloseCodes.ShardingRequired,
    "Discord gateway closed: sharding required",
  ],
  [
    GatewayCloseCodes.InvalidAPIVersion,
    "Discord gateway closed: invalid API version",
  ],
  [GatewayCloseCodes.InvalidIntents, "Discord gateway closed: invalid intents"],
  [
    GatewayCloseCodes.DisallowedIntents,
    "Discord gateway closed: disallowed intents; check that the bot's Message Content intent is enabled",
  ],
])

/**
 * Discord threads as threads. A member's message in a watched channel opens
 * one when triage accepts it, a later message in it is a follow-up, and the
 * reply is a message the bot posts in it. REST works from startup; the socket
 * that brings new messages opens only when the host starts listening.
 */
export function createDiscordGateway(
  config: ChatConfig,
  host: GatewayHost,
): Gateway {
  const discord = new DiscordClient(config.token)
  return createChatGateway(
    PLATFORM,
    config,
    host,
    Effect.succeed(discord),
    (intake, admitter) =>
      listenEffect(config, discord, (error) => intake.lost(error), admitter),
  )
}

function listenEffect(
  config: ChatConfig,
  discord: DiscordClient,
  lost: (error: Error) => Effect.Effect<void>,
  admitter: Admitter,
): Effect.Effect<void, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    // Also checks the token before the socket opens.
    const me = yield* discord
      .currentUserEffect()
      .pipe(
        Effect.mapError(
          (error) =>
            new Error(
              error.status === 401
                ? "Discord rejected DISCORD_BOT_TOKEN"
                : `Discord is unreachable (status ${error.status ?? "none"})`,
            ),
        ),
      )
    const admit = admitter(discord, me.id)
    const socket = new WebSocketManager({
      token: config.token,
      intents: INTENTS,
      rest: discord.rest,
    })
    // Added before the handlers, so it runs after them, and before connecting,
    // so a connect that fails or times out still closes the socket.
    yield* Effect.addFinalizer(() => destroyEffect(socket))
    // Closing the scope interrupts admissions in flight, except one that is
    // opening a thread, which finishes first. Anything the socket delivers
    // after that is dropped.
    const handlers = yield* FiberSet.make()
    const run = yield* FiberSet.runtime(handlers)()
    // Opens once connecting succeeds.
    const listening = yield* Latch.make(false)
    // A fatal close leaves the shard waiting for READY, so connecting races
    // this rather than running into READY_TIMEOUT.
    const closed = yield* Deferred.make<never, Error>()
    // These come from the socket library, such as "Used disallowed intents",
    // and carry no message content.
    socket.on(WebSocketShardEvents.Error, (error) => {
      logEvent("discord.socket_error", { error: error.message }, "error")
    })
    // After a fatal close the host would stay up and hear nothing, so one
    // while connecting fails startup and one after listening stops the host.
    // The listening wait of one while connecting ends when the failed
    // startup closes the scope. The close event carries only its code.
    socket.on(WebSocketShardEvents.Closed, (code) => {
      const reason = FATAL_CLOSES.get(code)
      if (reason === undefined) return
      logEvent("discord.socket_dead", { code }, "error")
      const error = new Error(`${reason} (close code ${code})`)
      Deferred.doneUnsafe(closed, Effect.fail(error))
      run(listening.whenOpen(lost(error)))
    })
    const client = new Client({ rest: discord.rest, gateway: socket })
    // Event emitters cannot await. The fiber set owns each admission.
    client.on(GatewayDispatchEvents.MessageCreate, (event) => {
      run(admit(chatArrival(event.data)))
    })
    yield* Effect.raceFirst(connectEffect(socket), Deferred.await(closed))
    yield* listening.open
    logEvent("discord.listening", { channels: config.channels.size })
  })
}

/**
 * `@discordjs/ws` 2.0.4 can leave `destroy` pending when it lands while a
 * shard waits for HELLO or READY, and the aborted wait then reconnects the
 * shard. Closing stops waiting after this; what that socket hears later is
 * dropped.
 */
function destroyEffect(socket: WebSocketManager) {
  return Effect.tryPromise(async () => socket.destroy()).pipe(
    Effect.timeoutOption(CLOSE_TIMEOUT),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.sync(() => {
            logEvent(
              "discord.close_timed_out",
              { after: CLOSE_TIMEOUT },
              "warn",
            )
          }),
        onSome: () => Effect.void,
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        logEvent(
          "discord.close_failed",
          { error: errorKind(Cause.squash(cause)) },
          "warn",
        )
      }),
    ),
  )
}

function connectEffect(socket: WebSocketManager) {
  return Effect.tryPromise({
    try: () => socket.connect(),
    catch: (cause) => new Error("Discord gateway connection failed", { cause }),
  }).pipe(
    Effect.timeoutOption(READY_TIMEOUT),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new Error(`Discord gateway was not ready within ${READY_TIMEOUT}`),
          ),
        onSome: () => Effect.void,
      }),
    ),
  )
}

/** Without the event's optional `channel_type`, admission looks the channel up. */
function chatArrival(message: GatewayMessageCreateDispatchData): ChatArrival {
  return {
    ...chatMessage(message),
    channelId: message.channel_id,
    inThread:
      message.channel_type === undefined
        ? undefined
        : THREAD_TYPES.has(message.channel_type),
    guildId: message.guild_id,
    member: message.member,
  }
}
