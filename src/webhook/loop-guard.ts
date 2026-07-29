import { webhookText, type SeerrWebhookPayload } from "./types.js"

/** Marker every blitzcrank comment carries; see `modelAnchor` in agent/session. */
export const BOT_COMMENT_MARKER = "[blitzcrank w/"

/**
 * True when a comment event was caused by blitzcrank's own comment.
 *
 * The marker in the comment body is checked first: `commentedBy_username` is
 * Seerr's `displayName`, which can be renamed, empty, or missing entirely from
 * a customized webhook template, and a missed match makes the agent answer
 * itself in a loop. A user quoting the marker only silences their own comment.
 */
export function isBotComment(
  payload: SeerrWebhookPayload,
  botUsername: string | undefined,
): boolean {
  const message = webhookText(payload.comment?.comment_message)
  if (message?.includes(BOT_COMMENT_MARKER)) return true
  const author = webhookText(payload.comment?.commentedBy_username)
  const bot = webhookText(botUsername)
  if (author === undefined || bot === undefined) return false
  return author.toLowerCase() === bot.toLowerCase()
}
