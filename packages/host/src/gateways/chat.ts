/**
 * Text handling shared by the chat gateways. Discord and Fluxer write
 * mentions the same way and render the same markdown, so a message reads the
 * same to the model from either.
 */

/** A message author or mention, as either platform sends one. */
export interface ChatUser {
  id: string
  username: string
  global_name?: string | null
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
