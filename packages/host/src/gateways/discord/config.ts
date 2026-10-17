/** Everything the Discord gateway reads from the environment. */
export interface DiscordConfig {
  /** The bot token, the host's only Discord credential. */
  token: string
  /** Channels the bot watches. It answers nowhere else, DMs included. */
  channels: ReadonlySet<string>
  /** Members who may use the bot, by user id. */
  users: ReadonlySet<string>
  /** Members who may use the bot, by role id. Either list admits a member. */
  roles: ReadonlySet<string>
  /** Classifier model as provider/model. There is no default. */
  triageModel: string
  /** How sure triage must be before an unmentioned message opens a thread. */
  triageThreshold: number
}

const SNOWFLAKE = /^\d{17,20}$/

export function loadDiscordConfig(): DiscordConfig {
  const token = process.env.DISCORD_BOT_TOKEN?.trim()
  if (!token) throw new Error("DISCORD_BOT_TOKEN is required")
  const channels = ids("DISCORD_CHANNELS")
  if (channels.size === 0) {
    throw new Error("DISCORD_CHANNELS must list at least one channel id")
  }
  const users = ids("DISCORD_ALLOWED_USERS")
  const roles = ids("DISCORD_ALLOWED_ROLES")
  // An empty allowlist would make the bot answer nobody, or tempt an
  // allow-all switch. Neither exists.
  if (users.size === 0 && roles.size === 0) {
    throw new Error(
      "DISCORD_ALLOWED_USERS or DISCORD_ALLOWED_ROLES must list at least one id",
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
    triageModel,
    triageThreshold: threshold(),
  }
}

function ids(name: string): ReadonlySet<string> {
  const values = (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")
  const invalid = values.find((value) => !SNOWFLAKE.test(value))
  if (invalid !== undefined) {
    throw new Error(`${name} must list Discord ids, got "${invalid}"`)
  }
  return new Set(values)
}

function threshold(): number {
  const value = process.env.DISCORD_TRIAGE_THRESHOLD
  if (value === undefined || value.trim() === "") return 0.8
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error(
      `DISCORD_TRIAGE_THRESHOLD must be above 0 and at most 1, got "${value}"`,
    )
  }
  return parsed
}
