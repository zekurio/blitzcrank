import dotenv from "dotenv";

dotenv.config();

export interface WebserverConfig {
  port: number;
}

export interface LoggingConfig {
  level: string;
}

export interface DiscordConfig {
  token: string;
  clientId: string;
  channelId: string;
}

export interface PostgresConfig {
  connectionString: string;
}

export interface JellyfinConfig {
  url: string;
  apiKey: string;
}

export interface JellyseerrConfig {
  url: string;
  apiKey: string;
}

export interface Config {
  logging: LoggingConfig;
  webserver: WebserverConfig;
  discord: DiscordConfig;
  postgres: PostgresConfig;
  jellyfin: JellyfinConfig;
  jellyseerr: JellyseerrConfig;
}

export const config: Config = {
  logging: {
    level: process.env.LOG_LEVEL ?? "info",
  },
  webserver: {
    port: parseInt(process.env.LISTEN_PORT ?? "8081"),
  },
  discord: {
    token: process.env.DISCORD_TOKEN ?? "",
    clientId: process.env.DISCORD_CLIENT_ID ?? "",
    channelId: process.env.DISCORD_CHANNEL_ID ?? "",
  },
  postgres: {
    connectionString: process.env.POSTGRES_URL ?? "",
  },
  jellyfin: {
    url: process.env.JELLYFIN_URL ?? "",
    apiKey: process.env.JELLYFIN_API_KEY ?? "",
  },
  jellyseerr: {
    url: process.env.JELLYSEERR_URL ?? "",
    apiKey: process.env.JELLYSEERR_API_KEY ?? "",
  },
};
