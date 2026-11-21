/**
 * A message and a channel as admission and the thread context read them, and
 * text handling. The client maps Fluxer's wire types onto these shapes, so
 * nothing past it reads a field the gateway does not use.
 */

/** The most a bot may post in one Fluxer message, in characters. */
export const MAX_CONTENT = 4_000

/** A message author or mention. */
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
  inThread: boolean
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
