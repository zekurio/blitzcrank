/** Everything the Seerr gateway reads from the environment. */
export interface SeerrConfig {
  url: string
  /** Host-side Seerr access only: comments, the issue read, the comment gate. */
  apiKey: string
  /** Seerr user id sent as X-Api-User so bot comments are attributed correctly. */
  botUserId: string | undefined
  /** Display name of the bot's Seerr user; its own comment webhooks are ignored. */
  botUsername: string | undefined
  /** Shared secret checked against the Authorization header of incoming webhooks. */
  webhookSecret: string | undefined
}

export function loadSeerrConfig(): SeerrConfig {
  const url = process.env.SEERR_URL
  const apiKey = process.env.SEERR_API_KEY
  if (!url || !apiKey) {
    throw new Error("SEERR_URL and SEERR_API_KEY are required")
  }
  return {
    url: url.replace(/\/+$/, ""),
    apiKey,
    botUserId: process.env.SEERR_BOT_USER_ID,
    botUsername: process.env.SEERR_BOT_USERNAME,
    webhookSecret: process.env.BLITZCRANK_WEBHOOK_SECRET,
  }
}
