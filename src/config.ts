import dotenv from "dotenv";

dotenv.config();

export interface LoggingConfig {
  level: string;
}

export interface DiscordConfig {
  token: string;
  clientId: string;
}

export interface PostgresConfig {
  connectionString: string;
}

export interface JellyfinConfig {
  url: string;
  apiKey: string;
}

export interface Config {
  logging: LoggingConfig;
  discord: DiscordConfig;
  postgres: PostgresConfig;
  jellyfin: JellyfinConfig;
}

export const config: Config = {
  logging: {
    level: process.env.LOG_LEVEL ?? "info",
  },
  discord: {
    token: process.env.DISCORD_TOKEN ?? "",
    clientId: process.env.DISCORD_CLIENT_ID ?? "",
  },
  postgres: {
    connectionString: process.env.POSTGRES_URL ?? "",
  },
  jellyfin: {
    url: process.env.JELLYFIN_URL ?? "",
    apiKey: process.env.JELLYFIN_API_KEY ?? "",
  },
};
