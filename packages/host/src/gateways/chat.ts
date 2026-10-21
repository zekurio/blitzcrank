import { Effect } from "effect"

/**
 * What the chat gateways share: a message and a channel as admission and the
 * thread context read them, the REST calls made on them, and text handling.
 * Discord and Fluxer write mentions the same way and render the same
 * markdown, so a message reads the same to the model from either. Each
 * platform maps its own types and codes onto these shapes and nothing else.
 */

/** Where a chat gateway differs from the other, for the shared code. */
export interface ChatPlatform {
  /** The gateway's name. It tags threads and starts its log events. */
  name: string
  /** The platform as people write it, for the model. */
  title: string
  /** The most one posted message may hold, in characters. */
  maxContent: number
  /** Whether a failure is the platform client's, safe to log by its codes. */
  isError(error: unknown): error is ChatError
}

/** The settings both chat gateways read the same way. */
export interface ChatConfig {
  /** Channels the bot watches. It answers nowhere else, DMs included. */
  channels: ReadonlySet<string>
  /** Members who may use the bot, by user id. */
  users: ReadonlySet<string>
  /** Members who may use the bot, by role id. Either list admits a member. */
  roles: ReadonlySet<string>
  /** How sure triage must be before an unmentioned message opens a thread. */
  triageThreshold: number
}

/** A message author or mention, as either platform sends one. */
export interface ChatUser {
  id: string
  username: string
  global_name?: string | null
}

export type MessageKind = "default" | "reply" | "thread_starter" | "other"

export interface ChatMessage {
  id: string
  author: ChatUser & { bot?: boolean }
  /** Posted through a webhook rather than by an account. */
  webhook: boolean
  kind: MessageKind
  content: string
  mentions: readonly ChatUser[]
  timestamp: string
  /** The message this one references, unless it has none or that is gone. */
  referenced: ChatMessage | undefined
}

/** A message as it arrives over the socket, with what admission checks. */
export interface ChatArrival extends ChatMessage {
  channelId: string
  /** Whether it was posted in a thread, or undefined when the event omits it. */
  inThread: boolean | undefined
  guildId: string | undefined
  /** The author's member in that guild, as the event carries it. */
  member: ChatMember | undefined
}

export interface ChatChannel {
  thread: boolean
  guildId: string | undefined
  /** A thread's parent channel, or a channel's category. */
  parentId: string | undefined
  ownerId: string | undefined
}

export interface ChatMember {
  roles: readonly string[]
}

/** How a platform's REST call failed. Only these fields reach a log. */
export interface ChatError {
  readonly status: number | undefined
  readonly code: number | string | undefined
}

/**
 * The REST calls a chat gateway makes, in its platform's message and channel
 * shapes. `DiscordClient` and `FluxerClient` are each one.
 */
export interface PlatformClient<Message, Channel> {
  channelEffect(channelId: string): Effect.Effect<Channel, ChatError>
  /** The member, or `undefined` once they have left the guild. */
  memberEffect(
    guildId: string,
    userId: string,
  ): Effect.Effect<ChatMember | undefined, ChatError>
  /** Newest first. */
  recentMessagesEffect(
    channelId: string,
    limit: number,
  ): Effect.Effect<readonly Message[], ChatError>
  startThreadEffect(
    channelId: string,
    messageId: string,
    name: string,
  ): Effect.Effect<{ id: string }, ChatError>
  postEffect(
    channelId: string,
    content: string,
    replyTo?: string,
  ): Effect.Effect<{ id: string }, ChatError>
  editEffect(
    channelId: string,
    messageId: string,
    content: string,
  ): Effect.Effect<unknown, ChatError>
  /** A message that is already gone counts as deleted. */
  deleteEffect(
    channelId: string,
    messageId: string,
  ): Effect.Effect<void, ChatError>
}

/** A platform's REST calls as the shared code makes them. */
export type ChatClient = PlatformClient<ChatMessage, ChatChannel>

/** The platform's client, its messages and channels read as chat shapes. */
export function chatClient<Message, Channel>(
  client: PlatformClient<Message, Channel>,
  toMessage: (message: Message) => ChatMessage,
  toChannel: (channel: Channel) => ChatChannel,
): ChatClient {
  return {
    channelEffect: (channelId) =>
      client.channelEffect(channelId).pipe(Effect.map(toChannel)),
    memberEffect: (guildId, userId) => client.memberEffect(guildId, userId),
    recentMessagesEffect: (channelId, limit) =>
      client
        .recentMessagesEffect(channelId, limit)
        .pipe(Effect.map((messages) => messages.map(toMessage))),
    startThreadEffect: (channelId, messageId, name) =>
      client.startThreadEffect(channelId, messageId, name),
    postEffect: (channelId, content, replyTo) =>
      client.postEffect(channelId, content, replyTo),
    editEffect: (channelId, messageId, content) =>
      client.editEffect(channelId, messageId, content),
    deleteEffect: (channelId, messageId) =>
      client.deleteEffect(channelId, messageId),
  }
}

/** Whether the message mentions the bot by user, in either mention form. */
export function mentionsBot(content: string, botId: string): boolean {
  return content.includes(`<@${botId}>`) || content.includes(`<@!${botId}>`)
}

/** The message as the model reads it: the bot's mention gone, others named. */
export function messageText(
  content: string,
  mentions: readonly ChatUser[],
  botId: string | undefined,
): string {
  const names = new Map(
    mentions.map((user) => [user.id, user.global_name ?? user.username]),
  )
  return content
    .replace(/<@!?(\d+)>/g, (token, id: string) => {
      if (id === botId) return ""
      const name = names.get(id)
      return name === undefined ? token : `@${name}`
    })
    .trim()
}

const MAX_THREAD_NAME = 80

/** A thread's name from the message that opens it, mentions and all removed. */
export function threadName(text: string): string {
  const plain = text
    .replace(/<(?:@[!&]?|#)\d+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!plain) return "blitzcrank"
  return plain.length <= MAX_THREAD_NAME
    ? plain
    : `${plain.slice(0, MAX_THREAD_NAME - 1).trimEnd()}…`
}

/** The text cut to `budget` characters, an ellipsis included. */
export function fit(text: string, budget: number): string {
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
