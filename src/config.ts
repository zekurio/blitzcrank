import dotenv from "dotenv";

dotenv.config();

export interface DiscordConfig {
  token: string;
  clientId: string;
}

export interface PostgresConfig {
  connectionString: string;
}

export interface Config {
  discord: DiscordConfig;
  postgres: PostgresConfig;
}

export const config: Config = {
  discord: {
    token: process.env.DISCORD_TOKEN ?? "",
    clientId: process.env.DISCORD_CLIENT_ID ?? "",
  },
  postgres: {
    connectionString: process.env.POSTGRES_URL ?? "",
  },
};
