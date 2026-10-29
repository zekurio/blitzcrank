import { ids, threshold } from "../chat-config.ts"
import type { ChatConfig } from "../chat.ts"

/** Everything the Discord gateway reads from the environment. */
export interface DiscordConfig extends ChatConfig {
  /** The bot token, the host's only Discord credential. */
  token: string
  /** Classifier model as provider/model. There is no default. */
  triageModel: string
}

export function loadDiscordConfig(): DiscordConfig {
  const token = process.env.DISCORD_BOT_TOKEN?.trim()
  if (!token) throw new Error("DISCORD_BOT_TOKEN is required")
  const channels = ids("DISCORD_CHANNELS", "Discord")
  if (channels.size === 0) {
    throw new Error("DISCORD_CHANNELS must list at least one channel id")
  }
  const users = ids("DISCORD_ALLOWED_USERS", "Discord")
  const roles = ids("DISCORD_ALLOWED_ROLES", "Discord")
  const adminUsers = ids("DISCORD_ADMIN_USERS", "Discord")
  const adminRoles = ids("DISCORD_ADMIN_ROLES", "Discord")
  // An empty allowlist would make the bot answer nobody, or tempt an
  // allow-all switch. Neither exists. An admin list admits its members too.
  if (
    users.size === 0 &&
    roles.size === 0 &&
    adminUsers.size === 0 &&
    adminRoles.size === 0
  ) {
    throw new Error(
      "DISCORD_ALLOWED_USERS, DISCORD_ALLOWED_ROLES, DISCORD_ADMIN_USERS, or DISCORD_ADMIN_ROLES must list at least one id",
    )
  }
  const triageModel = process.env.DISCORD_TRIAGE_MODEL?.trim()
  if (!triageModel) {
    throw new Error(
      "DISCORD_TRIAGE_MODEL must name a classifier model, e.g. opencode/jev-1.13",
    )
  }
  return {
    // REST adds the scheme itself.
    token: token.replace(/^Bot\s+/i, ""),
    channels,
    users,
    roles,
    adminUsers,
    adminRoles,
    triageModel,
    triageThreshold: threshold("DISCORD_TRIAGE_THRESHOLD"),
  }
}
