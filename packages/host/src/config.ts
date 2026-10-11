export interface ServiceConfig {
  url: string
  apiKey: string
}

export interface McpConfig {
  /** Streamable HTTP endpoint, e.g. http://127.0.0.1:8485/mcp. */
  url: string
  /** Bearer token the server checks on every request. */
  token: string
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
  /** Host-side Seerr access only: comments, issue status, the comment gate. */
  seerr: ServiceConfig
  /** The MCP server every agent-facing service read and write goes through. */
  mcp: McpConfig
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

/**
 * The agent reaches Sonarr, Radarr, SABnzbd, Jellyfin, Seerr, and media files
 * only through the MCP server, which also holds their credentials. Without it
 * every run could only fail, so both values are mandatory.
 */
function mcp(): McpConfig {
  const url = process.env.BLITZCRANK_MCP_URL
  const token = process.env.BLITZCRANK_MCP_TOKEN
  if (!url || !token) {
    throw new Error("BLITZCRANK_MCP_URL and BLITZCRANK_MCP_TOKEN are required")
  }
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
    throw new Error(`BLITZCRANK_MCP_URL must be an http(s) URL, got "${url}"`)
  }
  return { url, token }
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
    mcp: mcp(),
  }
}
