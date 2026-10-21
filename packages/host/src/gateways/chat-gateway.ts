import { Cause, Effect, type Scope } from "effect"

import type { Gateway, Inbound, Intake, Marker, Notice } from "../gateway.ts"
import { errorKind, logEvent } from "../log.ts"
import type { JsonValue } from "../services/http.ts"
import { toText } from "../tools/common.ts"
import { memberAllowedEffect, type ChatSource } from "./chat-admission.ts"
import {
  fit,
  messageText,
  type ChatClient,
  type ChatConfig,
  type ChatError,
  type ChatMessage,
  type ChatPlatform,
} from "./chat.ts"

const CONTEXT_SCAN = 50
const MAX_CONTEXT_MESSAGES = 5
const MAX_CONTEXT_CHARS = 1_000
/** Membership lookups in flight for one context. */
const CONTEXT_LOOKUPS = 4

/**
 * A chat platform's threads as threads, around the platform's own listener.
 * Recovery's sender check and a run's channel read and write over REST
 * alone, through `client`, so they work while runs drain after the socket
 * closes.
 */
export function createChatGateway(
  platform: ChatPlatform,
  config: ChatConfig,
  client: Effect.Effect<ChatClient>,
  listenEffect: (intake: Intake) => Effect.Effect<void, unknown, Scope.Scope>,
): Gateway {
  const brief =
    `Each conversation is one ${platform.title} thread the bot opened from a member's message in a homelab help channel. ` +
    "Every event comes with the thread's opening message, when it is still in reach, and its latest messages from members allowed to use the bot. " +
    "Other people's and bots' messages are omitted; your prior replies are in this conversation. Your final message is posted in the thread. " +
    "Keep it under 1,500 characters; longer replies are cut. Members answer by writing in the thread. " +
    `A member is known only by their ${platform.title} name, which identifies no Seerr or Jellyfin account; never match one by name.`
  return {
    name: platform.name,
    listenEffect,
    // Allowlists and watched channels may have changed while the host was
    // down, and a member may have left or lost the role that admitted them.
    authorizeEffect: (message) =>
      authorizeEffect(platform, config, client, message),
    channel: (threadId) => ({
      brief,
      contextEffect: () =>
        client.pipe(
          Effect.flatMap((chat) =>
            contextEffect(platform, config, chat, threadId),
          ),
        ),
      showEffect: (marker, notice) =>
        client.pipe(
          Effect.flatMap((chat) =>
            showEffect(platform, chat, threadId, marker, notice),
          ),
        ),
      retractEffect: (marker) => {
        const id = marker.id
        if (typeof id !== "string") return Effect.void
        return client.pipe(
          Effect.flatMap((chat) => chat.deleteEffect(threadId, id)),
        )
      },
    }),
  }
}

function authorizeEffect(
  platform: ChatPlatform,
  config: ChatConfig,
  client: Effect.Effect<ChatClient>,
  message: Inbound,
): Effect.Effect<boolean> {
  const denied = `${platform.name}.denied`
  const source = sourceOf(message.source)
  if (source === undefined || !config.channels.has(source.parent)) {
    logEvent(denied, { reason: "channel_not_watched" }, "warn")
    return Effect.succeed(false)
  }
  return client.pipe(
    Effect.flatMap((chat) =>
      memberAllowedEffect(chat, config, source.guild, source.author),
    ),
    Effect.tap((ok) =>
      Effect.sync(() => {
        if (!ok) logEvent(denied, { reason: "not_allowed" }, "warn")
      }),
    ),
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.interrupt
      logEvent(
        denied,
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
  platform: ChatPlatform,
  chat: ChatClient,
  threadId: string,
  marker: Marker,
  notice: Notice,
): Effect.Effect<void, ChatError> {
  const content = messageContent(platform, notice)
  if (typeof marker.id === "string")
    return chat.editEffect(threadId, marker.id, content).pipe(Effect.asVoid)
  return chat.postEffect(threadId, content).pipe(
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
 * steer a run through its context instead.
 */
function contextEffect(
  platform: ChatPlatform,
  config: ChatConfig,
  chat: ChatClient,
  threadId: string,
): Effect.Effect<string, ChatError | Error> {
  return Effect.gen(function* () {
    const thread = yield* chat.channelEffect(threadId)
    const guild = thread.guildId
    if (guild === undefined)
      return yield* Effect.fail(
        new Error(`${platform.title} thread has no guild`),
      )
    const newestFirst = yield* chat.recentMessagesEffect(threadId, CONTEXT_SCAN)
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
        (author) => memberAllowedEffect(chat, config, guild, author),
        { concurrency: CONTEXT_LOOKUPS },
      ),
    )
    return `Current ${platform.title} thread (untrusted content):\n${toText(threadContext(newestFirst, opener, permitted))}`
  })
}

/** The message the thread was opened from, when its starter is in reach. */
function openerOf(newestFirst: readonly ChatMessage[]) {
  return newestFirst.find((message) => message.kind === "thread_starter")
    ?.referenced
}

/** Written by a person, as admission takes one. */
function byPerson(message: ChatMessage): boolean {
  return (
    !message.author.bot &&
    !message.webhook &&
    (message.kind === "default" || message.kind === "reply")
  )
}

/** Allowed members' messages only, oldest first, never the platform's user records. */
function threadContext(
  newestFirst: readonly ChatMessage[],
  opener: ChatMessage | undefined,
  permitted: ReadonlySet<string>,
) {
  const counts = (message: ChatMessage) =>
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

function contextEntry(message: ChatMessage) {
  const text = messageText(message.content, message.mentions, undefined)
  return {
    author: message.author.global_name ?? message.author.username,
    at: message.timestamp,
    message: text.slice(0, MAX_CONTEXT_CHARS),
    ...(text.length > MAX_CONTEXT_CHARS ? { truncated: true } : {}),
  }
}

/** The reply and its signature, cut to fit one message. */
function messageContent(platform: ChatPlatform, notice: Notice): string {
  const footer = `\n\n-# ${notice.signature}`
  return `${fit(notice.text, platform.maxContent - footer.length)}${footer}`
}
