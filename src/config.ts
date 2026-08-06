import { isAbsolute, resolve } from "node:path"

export interface ServiceConfig {
  url: string
  apiKey: string
}

export interface FirecrawlConfig {
  apiKey: string
  /** API base; override for self-hosted Firecrawl. */
  apiUrl: string
}

export interface AnvilConfig {
  command: string
  socket: string
}

export interface DiscordConfig {
  token: string
  /** Guild whose commands are registered; interactions elsewhere are refused. */
  guildId: string
  /** Text channel the per-automation report threads live in. */
  watchChannelId: string
  /**
   * Roles allowed to trigger automations, on top of guild administrators.
   * Empty means administrators only.
   */
  adminRoleIds: string[]
}

export interface MediaConfig {
  /** Absolute directory roots media_probe may read; nothing else is readable. */
  roots: string[]
}

export interface Config {
  port: number
  /** Persistent state (session transcripts) lives here. */
  dataDir: string
  /** Directory containing automation definition .md files. */
  automationsDir: string
  /** Shared secret checked against the Authorization header of incoming webhooks. */
  webhookSecret: string | undefined
  /** Model for issue runs, e.g. "anthropic/claude-sonnet-4-5". */
  model: string | undefined
  /** Default model for automations; absent inherits `model`. */
  automationModel: string | undefined
  /** Per-automation model overrides, keyed by automation name. */
  automationModels: Record<string, string>
  /**
   * pi auth.json holding API keys and OAuth credentials (e.g. openai-codex).
   * Must be writable: OAuth tokens auto-refresh and are persisted back.
   * Defaults to pi's own ~/.pi/agent/auth.json when unset.
   */
  authPath: string | undefined
  /** pi models.json declaring custom providers. */
  modelsPath: string | undefined
  /** Enables web_search/web_fetch tools in issue runs when configured. */
  firecrawl: FirecrawlConfig | undefined
  /** Language for public comments (default German, matching the deployment). */
  language: string
  /** Seerr user id sent as X-Api-User so bot comments are attributed correctly. */
  seerrBotUserId: string | undefined
  /** Display name of the bot's Seerr user; its own comment webhooks are ignored. */
  seerrBotUsername: string | undefined
  seerr: ServiceConfig
  sonarr: ServiceConfig | undefined
  radarr: ServiceConfig | undefined
  sabnzbd: ServiceConfig | undefined
  jellyfin: ServiceConfig | undefined
  anvil: AnvilConfig | undefined
  /** Enables the ffprobe-backed media_probe tool when media roots are set. */
  media: MediaConfig | undefined
  /** Automation report threads + trigger commands; host-side only. */
  discord: DiscordConfig | undefined
}

function service(prefix: string): ServiceConfig | undefined {
  const url = process.env[`${prefix}_URL`]
  const apiKey = process.env[`${prefix}_API_KEY`]
  if (!url || !apiKey) return undefined
  return { url: url.replace(/\/+$/, ""), apiKey }
}

/** A port that silently becomes NaN would bind nowhere useful. */
function number(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim() === "") return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number, got "${value}"`)
  }
  return parsed
}

/** A structured env value is strict: malformed routing must stop startup. */
export function parseAutomationModels(
  value: string | undefined,
): Record<string, string> {
  if (value === undefined || value.trim() === "") return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(
      "BLITZCRANK_AUTOMATION_MODELS must be a JSON object mapping automation names to model specs",
    )
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "BLITZCRANK_AUTOMATION_MODELS must be a JSON object mapping automation names to model specs",
    )
  }

  const entries = Object.entries(parsed)
  for (const [name, model] of entries) {
    if (typeof model !== "string" || model.trim() === "") {
      throw new Error(
        `BLITZCRANK_AUTOMATION_MODELS[${JSON.stringify(name)}] must be a non-empty model spec`,
      )
    }
  }
  return Object.fromEntries(entries) as Record<string, string>
}

/** Colon-separated absolute paths, PATH-style. */
function absoluteRoots(name: string, value: string | undefined): string[] {
  const roots = (value ?? "")
    .split(":")
    .map((root) => root.trim())
    .filter((root) => root.length > 0)
  for (const root of roots) {
    if (!isAbsolute(root) || root.includes("\0")) {
      throw new Error(`${name} entries must be absolute paths, got "${root}"`)
    }
    if (resolve(root) === "/") {
      throw new Error(`${name} must name directories, not the whole filesystem`)
    }
  }
  return roots.map((root) => resolve(root))
}

/**
 * All three ids are required together: a bot that cannot find its channel
 * would report into the void, so half a configuration is a startup error.
 */
function discord(): DiscordConfig | undefined {
  const token = process.env.DISCORD_BOT_TOKEN
  if (!token) return undefined
  const guildId = process.env.DISCORD_GUILD_ID
  const watchChannelId = process.env.DISCORD_WATCH_CHANNEL_ID
  if (!guildId || !watchChannelId) {
    throw new Error(
      "DISCORD_BOT_TOKEN requires DISCORD_GUILD_ID and DISCORD_WATCH_CHANNEL_ID",
    )
  }
  return {
    token,
    guildId,
    watchChannelId,
    adminRoleIds: (process.env.DISCORD_ADMIN_ROLE_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  }
}

/** Media roots unset means the probe tool is not registered at all. */
function media(): MediaConfig | undefined {
  const roots = absoluteRoots(
    "BLITZCRANK_MEDIA_ROOTS",
    process.env.BLITZCRANK_MEDIA_ROOTS,
  )
  if (roots.length === 0) return undefined
  return { roots }
}

export function loadConfig(): Config {
  const seerr = service("SEERR")
  if (!seerr) {
    throw new Error("SEERR_URL and SEERR_API_KEY are required")
  }
  return {
    port: number("BLITZCRANK_PORT", process.env.BLITZCRANK_PORT, 8484),
    dataDir: process.env.BLITZCRANK_DATA_DIR ?? "data",
    automationsDir: process.env.BLITZCRANK_AUTOMATIONS_DIR ?? "automations",
    webhookSecret: process.env.BLITZCRANK_WEBHOOK_SECRET,
    model: process.env.BLITZCRANK_MODEL,
    automationModel: process.env.BLITZCRANK_AUTOMATION_MODEL,
    automationModels: parseAutomationModels(
      process.env.BLITZCRANK_AUTOMATION_MODELS,
    ),
    authPath: process.env.BLITZCRANK_AUTH_PATH,
    modelsPath: process.env.BLITZCRANK_MODELS_PATH,
    firecrawl: process.env.FIRECRAWL_API_KEY
      ? {
          apiKey: process.env.FIRECRAWL_API_KEY,
          apiUrl: (
            process.env.FIRECRAWL_API_URL ?? "https://api.firecrawl.dev"
          ).replace(/\/+$/, ""),
        }
      : undefined,
    language: process.env.BLITZCRANK_LANGUAGE ?? "German",
    seerrBotUserId: process.env.SEERR_BOT_USER_ID,
    seerrBotUsername: process.env.SEERR_BOT_USERNAME,
    seerr,
    sonarr: service("SONARR"),
    radarr: service("RADARR"),
    sabnzbd: service("SABNZBD"),
    jellyfin: service("JELLYFIN"),
    anvil: process.env.ANVIL_CONTROL_SOCKET
      ? {
          command: process.env.ANVIL_COMMAND ?? "anvilctl",
          socket: process.env.ANVIL_CONTROL_SOCKET,
        }
      : undefined,
    media: media(),
    discord: discord(),
  }
}
