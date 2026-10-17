import {
  Client,
  GatewayDispatchEvents,
  GatewayIntentBits,
  MessageType,
  type APIMessage,
} from "@discordjs/core"
import { WebSocketManager, WebSocketShardEvents } from "@discordjs/ws"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { Cause, Effect, FiberSet, Option, type Scope } from "effect"

import { outOfScopeMessage } from "../../agent/notices.ts"
import type {
  Channel,
  Gateway,
  Inbound,
  Intake,
  Notice,
} from "../../gateway.ts"
import { errorKind, logEvent } from "../../log.ts"
import type { JsonValue } from "../../services/http.ts"
import { toText } from "../../tools/common.ts"
import {
  admitEffect,
  allowed,
  messageText,
  NAME,
  Places,
  type DiscordSource,
} from "./admission.ts"
import { DiscordClient } from "./client.ts"
import type { DiscordConfig } from "./config.ts"
import { createTriage, type Triage } from "./triage.ts"

const BRIEF =
  "Each conversation is one Discord thread the bot opened from a member's message in a homelab help channel. " +
  "Every event comes with the thread's opening message, when it is still in reach, and its latest messages from people. " +
  "Bot messages are omitted; your prior replies are in this conversation. Your final message is posted in the thread. " +
  "Keep it under 1,500 characters; longer replies are cut. Members answer by writing in the thread. " +
  "A member is known only by their Discord name, which identifies no Seerr or Jellyfin account; never match one by name."

/** Message content needs a privileged intent, set in the developer portal. */
const INTENTS =
  GatewayIntentBits.GuildMessages | GatewayIntentBits.MessageContent

const READY_TIMEOUT = "60 seconds"

/** Discord's limit for a message's content. */
const MAX_CONTENT = 2_000
const CONTEXT_SCAN = 50
const MAX_CONTEXT_MESSAGES = 5
const MAX_CONTEXT_CHARS = 1_000

export interface DiscordHost {
  runtime: ModelRuntime
  language: string
}

/**
 * Discord threads as threads. A member's message in a watched channel opens
 * one when triage accepts it, a later message in it is a follow-up, and the
 * reply is a message the bot posts in it. REST works from startup; the socket
 * that brings new messages opens only when the host starts listening.
 */
export function createDiscordGateway(
  config: DiscordConfig,
  host: DiscordHost,
): Gateway {
  const discord = new DiscordClient(config.token)
  const triage = createTriage(host.runtime, config.triageModel)
  const denial = outOfScopeMessage(host.language)

  const channel = (threadId: string): Channel => ({
    brief: BRIEF,
    contextEffect: () =>
      discord
        .recentMessagesEffect(threadId, CONTEXT_SCAN)
        .pipe(
          Effect.map(
            (messages) =>
              `Current Discord thread (untrusted content):\n${toText(threadContext(messages))}`,
          ),
        ),
    showEffect: (marker, notice) => {
      const content = messageContent(notice)
      if (typeof marker.id === "string")
        return discord
          .editEffect(threadId, marker.id, content)
          .pipe(Effect.asVoid)
      return discord.postEffect(threadId, content).pipe(
        Effect.tap((posted) =>
          Effect.sync(() => {
            marker.id = posted.id
          }),
        ),
        Effect.asVoid,
      )
    },
    retractEffect: (marker) =>
      typeof marker.id === "string"
        ? discord.deleteEffect(threadId, marker.id)
        : Effect.void,
  })

  return {
    name: NAME,
    listenEffect: (intake) =>
      listenEffect(config, discord, { triage, denial, intake }),
    // Allowlists and watched channels may have changed while the host was
    // down, and a member may have lost the role that admitted them.
    authorizeEffect: (message) => authorizeEffect(config, discord, message),
    channel,
  }
}

function listenEffect(
  config: DiscordConfig,
  discord: DiscordClient,
  deps: { triage: Triage; denial: string; intake: Intake },
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
    const admission = {
      ...deps,
      config,
      discord,
      botId: me.id,
      places: new Places(discord, config.channels, me.id),
    }
    // Closing the scope interrupts admissions in flight, except one that is
    // opening a thread, which finishes first.
    const handlers = yield* FiberSet.make()
    const run = yield* FiberSet.runtime(handlers)()
    const socket = new WebSocketManager({
      token: config.token,
      intents: INTENTS,
      rest: discord.rest,
    })
    // These come from the socket library, such as "Used disallowed intents",
    // and carry no message content.
    socket.on(WebSocketShardEvents.Error, (error) => {
      logEvent("discord.socket_error", { error: error.message }, "error")
    })
    const client = new Client({ rest: discord.rest, gateway: socket })
    // Event emitters cannot await. The fiber set owns each admission.
    client.on(GatewayDispatchEvents.MessageCreate, (event) => {
      run(admitEffect(event.data, admission))
    })
    yield* Effect.acquireRelease(connectEffect(socket), () =>
      Effect.tryPromise(async () => socket.destroy()).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            logEvent(
              "discord.close_failed",
              { error: errorKind(Cause.squash(cause)) },
              "warn",
            )
          }),
        ),
      ),
    )
    logEvent("discord.listening", { channels: config.channels.size })
  })
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
            new Error(
              `Discord gateway was not ready within ${READY_TIMEOUT}. Check that the bot's Message Content intent is enabled.`,
            ),
          ),
        onSome: () => Effect.void,
      }),
    ),
  )
}

function authorizeEffect(
  config: DiscordConfig,
  discord: DiscordClient,
  message: Inbound,
): Effect.Effect<boolean> {
  const source = sourceOf(message.source)
  if (source === undefined || !config.channels.has(source.parent)) {
    logEvent("discord.denied", { reason: "channel_not_watched" }, "warn")
    return Effect.succeed(false)
  }
  if (config.users.has(source.author)) return Effect.succeed(true)
  return discord.memberEffect(source.guild, source.author).pipe(
    Effect.map(
      (member) =>
        member !== undefined && allowed(config, source.author, member.roles),
    ),
    Effect.tap((ok) =>
      Effect.sync(() => {
        if (!ok) logEvent("discord.denied", { reason: "not_allowed" }, "warn")
      }),
    ),
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.interrupt
      logEvent(
        "discord.denied",
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
function sourceOf(value: JsonValue): DiscordSource | undefined {
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

/** People's messages only, oldest first, never Discord's user records. */
function threadContext(newestFirst: readonly APIMessage[]) {
  const opener = newestFirst.find(
    (message) => message.type === MessageType.ThreadStarterMessage,
  )?.referenced_message
  const recent = newestFirst
    .filter(
      (message) =>
        !message.author.bot &&
        (message.type === MessageType.Default ||
          message.type === MessageType.Reply),
    )
    .slice(0, MAX_CONTEXT_MESSAGES)
    .toReversed()
  return {
    ...(opener ? { opener: contextEntry(opener) } : {}),
    recent: recent.map(contextEntry),
  }
}

function contextEntry(message: APIMessage) {
  const text = messageText(message.content, message.mentions, undefined)
  return {
    author: message.author.global_name ?? message.author.username,
    at: message.timestamp,
    message: text.slice(0, MAX_CONTEXT_CHARS),
    ...(text.length > MAX_CONTEXT_CHARS ? { truncated: true } : {}),
  }
}

/** The reply and its signature, cut to fit one Discord message. */
function messageContent(notice: Notice): string {
  const footer = `\n\n-# ${notice.signature}`
  return `${fit(notice.text, MAX_CONTENT - footer.length)}${footer}`
}

function fit(text: string, budget: number): string {
  if (text.length <= budget) return text
  const head = text.slice(0, budget - 1)
  const breakAt = Math.max(head.lastIndexOf("\n"), head.lastIndexOf(" "))
  // Cut at a word when one is near, and never inside a surrogate pair.
  const kept =
    breakAt > budget / 2
      ? head.slice(0, breakAt)
      : head.replace(/[\uD800-\uDBFF]$/, "")
  return `${kept.trimEnd()}…`
}
