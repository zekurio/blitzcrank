/** Everything the Fluxer gateway reads from the environment. */
export interface FluxerConfig {
  /**
   * The instance's web origin, such as https://fluxer.app, with no trailing
   * slash. Its discovery document names the API and gateway endpoints.
   */
  instance: string
  /** The bot token, the host's only Fluxer credential. */
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
/** `<application id>.<secret>`, as Fluxer issues a bot token. */
const BOT_TOKEN = /^\d{17,20}\.[A-Za-z0-9_-]{16,}$/

export function loadFluxerConfig(): FluxerConfig {
  const instance = instanceOrigin()
  const token = process.env.FLUXER_BOT_TOKEN?.trim().replace(/^Bot\s+/i, "")
  if (!token) throw new Error("FLUXER_BOT_TOKEN is required")
  // The value never goes into the message: it is the credential.
  if (!BOT_TOKEN.test(token)) {
    throw new Error(
      "FLUXER_BOT_TOKEN must be a bot token of the form <application id>.<secret>",
    )
  }
  const channels = ids("FLUXER_CHANNELS")
  if (channels.size === 0) {
    throw new Error("FLUXER_CHANNELS must list at least one channel id")
  }
  const users = ids("FLUXER_ALLOWED_USERS")
  const roles = ids("FLUXER_ALLOWED_ROLES")
  // An empty allowlist would make the bot answer nobody, or tempt an
  // allow-all switch. Neither exists.
  if (users.size === 0 && roles.size === 0) {
    throw new Error(
      "FLUXER_ALLOWED_USERS or FLUXER_ALLOWED_ROLES must list at least one id",
    )
  }
  const triageModel = process.env.FLUXER_TRIAGE_MODEL?.trim()
  if (!triageModel) {
    throw new Error(
      "FLUXER_TRIAGE_MODEL must name a classifier model, e.g. opencode/jev-1.13",
    )
  }
  return {
    instance,
    // REST adds the scheme itself, and Identify takes the bare token.
    token,
    channels,
    users,
    roles,
    triageModel,
    triageThreshold: threshold(),
  }
}

/**
 * Only an origin: discovery lives at its root, and everything else comes
 * from there. The value is not echoed, since a URL can carry a password.
 */
function instanceOrigin(): string {
  const value = process.env.FLUXER_INSTANCE_URL?.trim()
  if (!value) {
    throw new Error(
      "FLUXER_INSTANCE_URL is required, e.g. https://fluxer.app or https://chat.example.com",
    )
  }
  const url = URL.parse(value)
  if (
    url === null ||
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "FLUXER_INSTANCE_URL must be an http(s) origin with no path, query, or credentials, e.g. https://fluxer.app",
    )
  }
  return url.origin
}

function ids(name: string): ReadonlySet<string> {
  const values = (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")
  const invalid = values.find((value) => !SNOWFLAKE.test(value))
  if (invalid !== undefined) {
    throw new Error(`${name} must list Fluxer ids, got "${invalid}"`)
  }
  return new Set(values)
}

function threshold(): number {
  const value = process.env.FLUXER_TRIAGE_THRESHOLD
  if (value === undefined || value.trim() === "") return 0.8
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error(
      `FLUXER_TRIAGE_THRESHOLD must be above 0 and at most 1, got "${value}"`,
    )
  }
  return parsed
}
