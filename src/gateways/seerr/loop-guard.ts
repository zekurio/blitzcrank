import { webhookText, type SeerrWebhookPayload } from "./types.ts"

/** Marker every blitzcrank comment carries; see `modelAnchor` in agent/session. */
export const BOT_COMMENT_MARKER = "[blitzcrank w/"

/**
 * True when a comment event was caused by blitzcrank's own comment.
 *
 * The marker in the comment body is checked first: `commentedBy_username` is
 * Seerr's `displayName`, which can be renamed, empty, or missing entirely from
 * a customized webhook template, and a missed match makes the agent answer
 * itself in a loop. A user quoting the marker only silences their own comment.
 *
 * Seerr does not seem to offer a way to check the ID of a comment author,
 * so we rely on the marker in the comment body instead and check the username if not present.
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
