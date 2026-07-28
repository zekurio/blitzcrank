export interface ServiceConfig {
  url: string;
  apiKey: string;
}

export interface FirecrawlConfig {
  apiKey: string;
  /** API base; override for self-hosted Firecrawl. */
  apiUrl: string;
}

export interface AnvilConfig {
  command: string;
  socket: string;
}

export interface Config {
  port: number;
  /** Persistent state (session transcripts) lives here. */
  dataDir: string;
  /** Directory containing automation definition .md files. */
  automationsDir: string;
  /** Shared secret checked against the Authorization header of incoming webhooks. */
  webhookSecret: string | undefined;
  /** Model string for the agent, e.g. "anthropic/claude-sonnet-4-5". */
  model: string | undefined;
  /**
   * pi auth.json holding API keys and OAuth credentials (e.g. openai-codex).
   * Must be writable: OAuth tokens auto-refresh and are persisted back.
   * Defaults to pi's own ~/.pi/agent/auth.json when unset.
   */
  authPath: string | undefined;
  /** pi models.json declaring custom providers. */
  modelsPath: string | undefined;
  /** Enables web_search/web_fetch tools in issue runs when configured. */
  firecrawl: FirecrawlConfig | undefined;
  /** Language for public comments (default German, matching the deployment). */
  language: string;
  /** Seerr user id sent as X-Api-User so bot comments are attributed correctly. */
  seerrBotUserId: string | undefined;
  /** Display name of the bot's Seerr user; its own comment webhooks are ignored. */
  seerrBotUsername: string | undefined;
  seerr: ServiceConfig;
  sonarr: ServiceConfig | undefined;
  radarr: ServiceConfig | undefined;
  sabnzbd: ServiceConfig | undefined;
  jellyfin: ServiceConfig | undefined;
  anvil: AnvilConfig | undefined;
}

function service(prefix: string): ServiceConfig | undefined {
  const url = process.env[`${prefix}_URL`];
  const apiKey = process.env[`${prefix}_API_KEY`];
  if (!url || !apiKey) return undefined;
  return { url: url.replace(/\/+$/, ""), apiKey };
}

export function loadConfig(): Config {
  const seerr = service("SEERR");
  if (!seerr) {
    throw new Error("SEERR_URL and SEERR_API_KEY are required");
  }
  return {
    port: Number(process.env.BLITZCRANK_PORT ?? 8484),
    dataDir: process.env.BLITZCRANK_DATA_DIR ?? "data",
    automationsDir: process.env.BLITZCRANK_AUTOMATIONS_DIR ?? "automations",
    webhookSecret: process.env.BLITZCRANK_WEBHOOK_SECRET,
    model: process.env.BLITZCRANK_MODEL,
    authPath: process.env.BLITZCRANK_AUTH_PATH,
    modelsPath: process.env.BLITZCRANK_MODELS_PATH,
    firecrawl: process.env.FIRECRAWL_API_KEY
      ? {
          apiKey: process.env.FIRECRAWL_API_KEY,
          apiUrl: (process.env.FIRECRAWL_API_URL ?? "https://api.firecrawl.dev").replace(/\/+$/, ""),
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
  };
}
