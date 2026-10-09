import { isAbsolute, resolve } from "node:path"

export interface ServiceConfig {
  url: string
  apiKey: string
}

export interface MediaConfig {
  /** Absolute directory roots media_probe may read; nothing else is readable. */
  roots: string[]
}

export type WebConfig =
  | { provider: "firecrawl"; apiKey: string }
  | { provider: "none" }

export interface Config {
  port: number
  /** Persistent state (session transcripts) lives here. */
  dataDir: string
  /** Shared secret checked against the Authorization header of incoming webhooks. */
  webhookSecret: string | undefined
  /**
   * Required model for issue runs, e.g. "anthropic/claude-sonnet-4-5".
   * blitzcrank deliberately ships no built-in model default.
   */
  model: string
  /**
   * Explicit auth file holding API keys and OAuth credentials.
   * Must be writable: OAuth tokens auto-refresh and are persisted back.
   * Blitzcrank's own auth lives at `<dataDir>/auth.json`
   * when unset; ambient pi state such as `~/.pi/agent/auth.json` is never read.
   */
  authPath: string | undefined
  /**
   * Explicit pi models.json declaring custom providers. Only this path is
   * loaded; unset loads no models file rather than discovering one.
   */
  modelsPath: string | undefined
  /** Language for public comments (default German, matching the deployment). */
  language: string
  /** External web search/extract for issue runs. */
  web: WebConfig
  /** Seerr user id sent as X-Api-User so bot comments are attributed correctly. */
  seerrBotUserId: string | undefined
  /** Display name of the bot's Seerr user; its own comment webhooks are ignored. */
  seerrBotUsername: string | undefined
  seerr: ServiceConfig
  sonarr: ServiceConfig | undefined
  radarr: ServiceConfig | undefined
  sabnzbd: ServiceConfig | undefined
  jellyfin: ServiceConfig | undefined
  /** Enables media reads; frame extraction also requires model image support. */
  media: MediaConfig | undefined
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
 * The operator's base model choice is mandatory: a built-in default would let
 * an upgrade silently change which model runs the deployment.
 */
function requiredModel(): string {
  const value = process.env.BLITZCRANK_MODEL
  if (value === undefined || value.trim() === "") {
    throw new Error(
      "BLITZCRANK_MODEL must name a model, e.g. provider/model[:thinking]",
    )
  }
  return value
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

/**
 * Web access is explicit opt-in: an unset provider means no external web
 * tools, even if a stray FIRECRAWL_API_KEY exists in the environment (the
 * same variable name is used by other tools, so its presence is not consent).
 */
function web(): WebConfig {
  const provider = process.env.BLITZCRANK_WEB_PROVIDER ?? "none"
  if (process.env.FIRECRAWL_URL) {
    throw new Error(
      "FIRECRAWL_URL is not supported; web tools use the hosted Firecrawl API",
    )
  }
  if (provider === "none") return { provider }
  if (provider !== "firecrawl") {
    throw new Error(
      `BLITZCRANK_WEB_PROVIDER must be firecrawl or none, got "${provider}"`,
    )
  }
  const apiKey = process.env.FIRECRAWL_API_KEY
  if (!apiKey) {
    throw new Error(
      "BLITZCRANK_WEB_PROVIDER=firecrawl requires FIRECRAWL_API_KEY",
    )
  }
  return { provider, apiKey }
}

export function loadConfig(): Config {
  const seerr = service("SEERR")
  if (!seerr) {
    throw new Error("SEERR_URL and SEERR_API_KEY are required")
  }
  return {
    port: number("BLITZCRANK_PORT", process.env.BLITZCRANK_PORT, 8484),
    dataDir: process.env.BLITZCRANK_DATA_DIR ?? "data",
    webhookSecret: process.env.BLITZCRANK_WEBHOOK_SECRET,
    model: requiredModel(),
    authPath: process.env.BLITZCRANK_AUTH_PATH,
    modelsPath: process.env.BLITZCRANK_MODELS_PATH,
    language: process.env.BLITZCRANK_LANGUAGE ?? "German",
    web: web(),
    seerrBotUserId: process.env.SEERR_BOT_USER_ID,
    seerrBotUsername: process.env.SEERR_BOT_USERNAME,
    seerr,
    sonarr: service("SONARR"),
    radarr: service("RADARR"),
    sabnzbd: service("SABNZBD"),
    jellyfin: service("JELLYFIN"),
    media: media(),
  }
}
