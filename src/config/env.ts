/** Compatibility adapter only. New structured settings belong in the file. */
export function configFromEnv(env: NodeJS.ProcessEnv) {
  if (env.FIRECRAWL_URL) {
    throw new Error(
      "FIRECRAWL_URL is not supported; web tools use the hosted Firecrawl API",
    )
  }
  const service = (prefix: string) => {
    const url = env[`${prefix}_URL`]
    const apiKey = env[`${prefix}_API_KEY`]
    // Preserve the env-only convention: incomplete optional services are off.
    return url && apiKey ? { url, apiKey } : undefined
  }
  const list = (value: string | undefined, separator = ",") =>
    (value ?? "")
      .split(separator)
      .map((item) => item.trim())
      .filter(Boolean)
  const seerr = service("SEERR")
  if (!seerr) throw new Error("SEERR_URL and SEERR_API_KEY are required")
  if (
    env.DISCORD_BOT_TOKEN &&
    (!env.DISCORD_GUILD_ID || !env.DISCORD_WATCH_CHANNEL_ID)
  ) {
    throw new Error(
      "DISCORD_BOT_TOKEN requires DISCORD_GUILD_ID and DISCORD_WATCH_CHANNEL_ID",
    )
  }
  return {
    version: 1,
    port: env.BLITZCRANK_PORT?.trim() ? Number(env.BLITZCRANK_PORT) : undefined,
    dataDir: env.BLITZCRANK_DATA_DIR,
    automationsDir: env.BLITZCRANK_AUTOMATIONS_DIR,
    webhookSecret: env.BLITZCRANK_WEBHOOK_SECRET,
    model: env.BLITZCRANK_MODEL,
    automationModel: env.BLITZCRANK_AUTOMATION_MODEL,
    automationModels: parseAutomationModels(env.BLITZCRANK_AUTOMATION_MODELS),
    authPath: env.BLITZCRANK_AUTH_PATH,
    modelsPath: env.BLITZCRANK_MODELS_PATH,
    language: env.BLITZCRANK_LANGUAGE,
    seerrBotUserId: env.SEERR_BOT_USER_ID,
    seerrBotUsername: env.SEERR_BOT_USERNAME,
    seerr,
    sonarr: service("SONARR"),
    radarr: service("RADARR"),
    sabnzbd: service("SABNZBD"),
    jellyfin: service("JELLYFIN"),
    anvil:
      env.ANVIL_CONTROL_SOCKET === undefined
        ? undefined
        : {
            socket: env.ANVIL_CONTROL_SOCKET.trim(),
            command: env.ANVIL_COMMAND?.trim(),
          },
    media: { roots: list(env.BLITZCRANK_MEDIA_ROOTS, ":") },
    web:
      (env.BLITZCRANK_WEB_PROVIDER ?? "none") === "none"
        ? { provider: "none" }
        : {
            provider: env.BLITZCRANK_WEB_PROVIDER,
            apiKey: env.FIRECRAWL_API_KEY,
          },
    gateways: env.DISCORD_BOT_TOKEN
      ? [
          {
            id: "discord",
            type: "discord",
            token: env.DISCORD_BOT_TOKEN,
            guildId: env.DISCORD_GUILD_ID,
            reportChannelId: env.DISCORD_WATCH_CHANNEL_ID,
            inboxChannelIds: env.DISCORD_INBOX_CHANNEL_ID
              ? [env.DISCORD_INBOX_CHANNEL_ID]
              : [],
            model: env.BLITZCRANK_DISCORD_MODEL,
            triageModel: env.BLITZCRANK_DISCORD_TRIAGE_MODEL,
            adminRoleIds: list(env.DISCORD_ADMIN_ROLE_IDS),
          },
        ]
      : [],
  }
}

function parseAutomationModels(value: string | undefined): unknown {
  if (!value?.trim()) return {}
  try {
    return JSON.parse(value)
  } catch {
    // JSON.parse errors may quote input. Never log potentially secret config.
    throw new Error("BLITZCRANK_AUTOMATION_MODELS must be a JSON object")
  }
}
