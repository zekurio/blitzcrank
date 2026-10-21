import { ids, threshold } from "../chat-config.ts"
import type { ChatConfig } from "../chat.ts"

/** Everything the Fluxer gateway reads from the environment. */
export interface FluxerConfig extends ChatConfig {
  /**
   * The instance's web origin, such as https://fluxer.app, with no trailing
   * slash. Its discovery document names the API and gateway endpoints.
   */
  instance: string
  /** The bot token, the host's only Fluxer credential. */
  token: string
  /** Classifier model as provider/model. There is no default. */
  triageModel: string
}

export function loadFluxerConfig(): FluxerConfig {
  const instance = instanceOrigin()
  // Its shape is not checked here: listening asks Fluxer before the socket
  // opens. The value never goes into a message: it is the credential.
  const token = process.env.FLUXER_BOT_TOKEN?.trim().replace(/^Bot\s+/i, "")
  if (!token) throw new Error("FLUXER_BOT_TOKEN is required")
  const channels = ids("FLUXER_CHANNELS", "Fluxer")
  if (channels.size === 0) {
    throw new Error("FLUXER_CHANNELS must list at least one channel id")
  }
  const users = ids("FLUXER_ALLOWED_USERS", "Fluxer")
  const roles = ids("FLUXER_ALLOWED_ROLES", "Fluxer")
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
    triageThreshold: threshold("FLUXER_TRIAGE_THRESHOLD"),
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
