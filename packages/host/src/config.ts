export interface McpConfig {
  /** Streamable HTTP endpoint, e.g. http://127.0.0.1:8485/mcp. */
  url: string
  /** Bearer token the server checks on every request. */
  token: string
}

export type WebConfig =
  | { provider: "firecrawl"; apiKey: string }
  | { provider: "none" }

/**
 * The host's own settings. A gateway reads its own in
 * `gateways/<name>/config.ts`, so none of them appear here.
 */
export interface Config {
  port: number
  /** The gateways to run, by name. Each reads its own settings. */
  gateways: readonly string[]
  /** How many threads may run at once. A thread never runs twice at once. */
  maxParallelRuns: number
  /** Persistent state (session transcripts) lives here. */
  dataDir: string
  /**
   * Required model for every run, e.g. "anthropic/claude-sonnet-4-5".
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
  /** Language of replies (default German, matching the deployment). */
  language: string
  /** External web search/extract for runs. */
  web: WebConfig
  /** The MCP server every agent-facing service read and write goes through. */
  mcp: McpConfig
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

/** Zero would accept every event and run none of them. */
function maxParallelRuns(): number {
  const value = number(
    "BLITZCRANK_MAX_PARALLEL_RUNS",
    process.env.BLITZCRANK_MAX_PARALLEL_RUNS,
    4,
  )
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `BLITZCRANK_MAX_PARALLEL_RUNS must be a whole number of at least 1, got "${value}"`,
    )
  }
  return value
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

/**
 * A deployment runs only the gateways it lists, so it needs no settings for
 * the others. Seerr alone unless the operator lists more.
 */
function gateways(): readonly string[] {
  const value = process.env.BLITZCRANK_GATEWAYS?.trim() || "seerr"
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "")
  if (names.length === 0) {
    throw new Error(
      `BLITZCRANK_GATEWAYS must name at least one gateway, got "${value}"`,
    )
  }
  return [...new Set(names)]
}

export function loadConfig(): Config {
  return {
    port: number("BLITZCRANK_PORT", process.env.BLITZCRANK_PORT, 8484),
    gateways: gateways(),
    maxParallelRuns: maxParallelRuns(),
    dataDir: process.env.BLITZCRANK_DATA_DIR ?? "data",
    model: requiredModel(),
    authPath: process.env.BLITZCRANK_AUTH_PATH,
    modelsPath: process.env.BLITZCRANK_MODELS_PATH,
    language: process.env.BLITZCRANK_LANGUAGE ?? "German",
    web: web(),
    mcp: mcp(),
  }
}
