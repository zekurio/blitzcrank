import dotenv from "dotenv";

dotenv.config();

export interface DiscordConfig {
  token: string;
  clientId: string;
}

export interface PostgresConfig {
  connectionString: string;
}

export interface SonarrConfig {
  url: string;
  apiKey: string;
}

export interface Config {
  discord: DiscordConfig;
  postgres: PostgresConfig;
  sonarr: SonarrConfig;
}

export const config: Config = {
  discord: {
    token: process.env.DISCORD_TOKEN ?? "",
    clientId: process.env.DISCORD_CLIENT_ID ?? "",
  },
  postgres: {
    connectionString: process.env.POSTGRES_URL ?? "",
  },
  sonarr: {
    url: process.env.SONARR_URL ?? "",
    apiKey: process.env.SONARR_API_KEY ?? "",
  },
};
