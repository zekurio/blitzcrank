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
  /** Model string for the agent, e.g. "anthropic/claude-sonnet-4-5". */
  model: string | undefined
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
  /**
   * Cumulative model spend allowed per issue, in USD. Enforced before and
   * during a run (the agent loop is aborted on reaching it); 0 disables it.
   */
  issueBudgetUsd: number
  /** Public comment posted once when an issue exhausts its budget. */
  budgetMessage: string
  /** Self-scheduled follow-ups allowed between two user messages. */
  maxRevisitChain: number
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
}

function service(prefix: string): ServiceConfig | undefined {
  const url = process.env[`${prefix}_URL`]
  const apiKey = process.env[`${prefix}_API_KEY`]
  if (!url || !apiKey) return undefined
  return { url: url.replace(/\/+$/, ""), apiKey }
}

/**
 * A cap that silently becomes NaN is not a cap: an unparsable budget would
 * disable the ceiling and make revisit chains unbounded.
 */
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
    issueBudgetUsd: number(
      "BLITZCRANK_ISSUE_BUDGET_USD",
      process.env.BLITZCRANK_ISSUE_BUDGET_USD,
      5,
    ),
    budgetMessage:
      process.env.BLITZCRANK_BUDGET_MESSAGE ??
      "Ich komme hier allein nicht weiter und melde mich nicht mehr automatisch. " +
        "Bitte wende dich an einen Admin, wenn das Problem weiter besteht.",
    maxRevisitChain: number(
      "BLITZCRANK_MAX_REVISITS",
      process.env.BLITZCRANK_MAX_REVISITS,
      3,
    ),
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
  }
}
