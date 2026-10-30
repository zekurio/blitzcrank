import type { ChatPlatform } from "./chat.ts"

/**
 * The settings a chat gateway reads, each under its name in capitals:
 * `DISCORD_BOT_TOKEN`, `FLUXER_CHANNELS`, and so on.
 */
export interface ChatConfig {
  /** The bot token, the host's only credential for the platform. */
  token: string
  /** Channels the bot watches. It answers nowhere else, DMs included. */
  channels: ReadonlySet<string>
  /** Members who may use the bot, by user id. */
  users: ReadonlySet<string>
  /** Members who may use the bot, by role id. Either list admits a member. */
  roles: ReadonlySet<string>
  /** Admins by user id. An admin may use the bot without another list. */
  adminUsers: ReadonlySet<string>
  /** Admins by role id. Either admin list makes a member an admin. */
  adminRoles: ReadonlySet<string>
  /** Classifier model as provider/model. There is no default. */
  triageModel: string
  /** How sure triage must be before an unmentioned message opens a thread. */
  triageThreshold: number
}

const SNOWFLAKE = /^\d{17,20}$/

export function loadChatConfig(
  platform: Pick<ChatPlatform, "name" | "title">,
): ChatConfig {
  const prefix = platform.name.toUpperCase()
  // REST adds the scheme itself, and Fluxer's Identify takes the bare token.
  // The value never goes into a message: it is the credential.
  const token = process.env[`${prefix}_BOT_TOKEN`]
    ?.trim()
    .replace(/^Bot\s+/i, "")
  if (!token) throw new Error(`${prefix}_BOT_TOKEN is required`)
  const list = (name: string) => ids(`${prefix}_${name}`, platform.title)
  const channels = list("CHANNELS")
  if (channels.size === 0) {
    throw new Error(`${prefix}_CHANNELS must list at least one channel id`)
  }
  const users = list("ALLOWED_USERS")
  const roles = list("ALLOWED_ROLES")
  const adminUsers = list("ADMIN_USERS")
  const adminRoles = list("ADMIN_ROLES")
  // An empty allowlist would make the bot answer nobody, or tempt an
  // allow-all switch. Neither exists. An admin list admits its members too.
  if ([users, roles, adminUsers, adminRoles].every((set) => set.size === 0)) {
    throw new Error(
      `${prefix}_ALLOWED_USERS, ${prefix}_ALLOWED_ROLES, ${prefix}_ADMIN_USERS, or ${prefix}_ADMIN_ROLES must list at least one id`,
    )
  }
  const triageModel = process.env[`${prefix}_TRIAGE_MODEL`]?.trim()
  if (!triageModel) {
    throw new Error(
      `${prefix}_TRIAGE_MODEL must name a classifier model, e.g. opencode/jev-1.13`,
    )
  }
  return {
    token,
    channels,
    users,
    roles,
    adminUsers,
    adminRoles,
    triageModel,
    triageThreshold: threshold(`${prefix}_TRIAGE_THRESHOLD`),
  }
}

/** The comma-separated ids in `name`, none when it is unset. */
function ids(name: string, platform: string): ReadonlySet<string> {
  const values = (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")
  const invalid = values.find((value) => !SNOWFLAKE.test(value))
  if (invalid !== undefined) {
    throw new Error(`${name} must list ${platform} ids, got "${invalid}"`)
  }
  return new Set(values)
}

/** The triage threshold in `name`, 0.8 when it is unset. */
function threshold(name: string): number {
  const value = process.env[name]
  if (value === undefined || value.trim() === "") return 0.8
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error(`${name} must be above 0 and at most 1, got "${value}"`)
  }
  return parsed
}
