import {
  API,
  ChannelType,
  MessageType,
  ThreadAutoArchiveDuration,
  type APIChannel,
  type APIMessage,
  type APIUser,
} from "@discordjs/core"
import { DiscordAPIError, HTTPError, REST } from "@discordjs/rest"
import { Data, Effect } from "effect"

import type {
  ChatChannel,
  ChatClient,
  ChatMember,
  ChatMessage,
  MessageKind,
} from "../chat.ts"

export class DiscordError extends Data.TaggedError("DiscordError")<{
  /** HTTP status, when Discord answered. */
  status: number | undefined
  /** Discord's JSON error code, such as 10008 for an unknown message. */
  code: number | string | undefined
  cause: unknown
}> {}

/** No post may ping anyone, whatever the text says. */
const NO_PINGS = { parse: [], replied_user: false }

export const THREAD_TYPES: ReadonlySet<ChannelType> = new Set([
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
])

const MESSAGE_KINDS: ReadonlyMap<MessageType, MessageKind> = new Map([
  [MessageType.Default, "default"],
  [MessageType.Reply, "reply"],
  [MessageType.ThreadStarterMessage, "thread_starter"],
])

/**
 * The gateway's REST access to Discord. It exists from startup, before the
 * socket opens and after it closes, so recovery and draining runs can use it.
 */
export class DiscordClient implements ChatClient {
  readonly rest: REST
  private readonly api: API

  constructor(token: string) {
    // No retries: repeating a post after a timeout can post it twice.
    this.rest = new REST({ version: "10", retries: 0 }).setToken(token)
    this.api = new API(this.rest)
  }

  currentUserEffect(): Effect.Effect<APIUser, DiscordError> {
    return call((signal) => this.api.users.getCurrent({ signal }))
  }

  channelEffect(channelId: string): Effect.Effect<ChatChannel, DiscordError> {
    return call((signal) => this.api.channels.get(channelId, { signal })).pipe(
      Effect.map(chatChannel),
    )
  }

  memberEffect(
    guildId: string,
    userId: string,
  ): Effect.Effect<ChatMember | undefined, DiscordError> {
    return call((signal) =>
      this.api.guilds.getMember(guildId, userId, { signal }),
    ).pipe(
      Effect.catchIf(
        (error) => error.status === 404,
        () => Effect.succeed(undefined),
      ),
    )
  }

  recentMessagesEffect(
    channelId: string,
    limit: number,
  ): Effect.Effect<ChatMessage[], DiscordError> {
    return call((signal) =>
      this.api.channels.getMessages(channelId, { limit }, { signal }),
    ).pipe(Effect.map((messages) => messages.map(chatMessage)))
  }

  startThreadEffect(
    channelId: string,
    messageId: string,
    name: string,
  ): Effect.Effect<{ id: string }, DiscordError> {
    return call((signal) =>
      this.api.channels.createThread(
        channelId,
        { name, auto_archive_duration: ThreadAutoArchiveDuration.OneDay },
        messageId,
        { signal },
      ),
    )
  }

  addThreadMemberEffect(
    threadId: string,
    userId: string,
  ): Effect.Effect<void, DiscordError> {
    return call((signal) =>
      this.api.threads.addMember(threadId, userId, { signal }),
    )
  }

  postEffect(
    channelId: string,
    content: string,
    replyTo?: string,
  ): Effect.Effect<{ id: string }, DiscordError> {
    return call((signal) =>
      this.api.channels.createMessage(
        channelId,
        {
          content,
          allowed_mentions: NO_PINGS,
          ...(replyTo === undefined
            ? {}
            : {
                message_reference: {
                  message_id: replyTo,
                  fail_if_not_exists: false,
                },
              }),
        },
        { signal },
      ),
    )
  }

  editEffect(
    channelId: string,
    messageId: string,
    content: string,
  ): Effect.Effect<void, DiscordError> {
    return call((signal) =>
      this.api.channels.editMessage(
        channelId,
        messageId,
        { content, allowed_mentions: NO_PINGS },
        { signal },
      ),
    ).pipe(Effect.asVoid)
  }

  deleteEffect(
    channelId: string,
    messageId: string,
  ): Effect.Effect<void, DiscordError> {
    return call((signal) =>
      this.api.channels.deleteMessage(channelId, messageId, { signal }),
    ).pipe(
      Effect.catchIf(
        (error) => error.status === 404,
        () => Effect.void,
      ),
    )
  }
}

export function chatMessage(message: APIMessage): ChatMessage {
  return {
    id: message.id,
    author: message.author,
    webhook: message.webhook_id !== undefined,
    kind: MESSAGE_KINDS.get(message.type) ?? "other",
    content: message.content,
    mentions: message.mentions,
    timestamp: message.timestamp,
    referenced: message.referenced_message
      ? chatMessage(message.referenced_message)
      : undefined,
  }
}

function chatChannel(channel: APIChannel): ChatChannel {
  return {
    thread: THREAD_TYPES.has(channel.type),
    guildId: "guild_id" in channel ? channel.guild_id : undefined,
    parentId:
      "parent_id" in channel ? (channel.parent_id ?? undefined) : undefined,
    ownerId: "owner_id" in channel ? channel.owner_id : undefined,
  }
}

function call<A>(
  request: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, DiscordError> {
  return Effect.tryPromise({
    try: request,
    catch: (cause) =>
      new DiscordError({
        status:
          cause instanceof DiscordAPIError || cause instanceof HTTPError
            ? cause.status
            : undefined,
        code: cause instanceof DiscordAPIError ? cause.code : undefined,
        cause,
      }),
  })
}
