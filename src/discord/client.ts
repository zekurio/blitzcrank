import { Client, REST, Routes } from "discord.js";
import { readyEventHandler } from "./events/ready";
import type { Config } from "../config";
import { interactionCreateEventHandler } from "./events/interactioncreate";
import { guildCreateEventHandler } from "./events/guildcreate";
import { commands } from "./commands";
import logger from "../logger";

export class ClientWrapper {
  private client: Client;
  private rest: REST;
  private config: Config;

  constructor(cfg: Config) {
    this.client = new Client({
      intents: ["Guilds", "GuildMessages", "DirectMessages"],
    });
    this.config = cfg;
    this.rest = new REST({ version: "10" }).setToken(this.config.discord.token);

    readyEventHandler(this);
    interactionCreateEventHandler(this);
    guildCreateEventHandler(this);
  }

  public getClient(): Client {
    return this.client;
  }

  async login(): Promise<string> {
    return this.client.login(this.config.discord.token);
  }

  async destroy(): Promise<void> {
    await this.client.destroy();
  }

  async registerCommands(guildId?: string): Promise<void> {
    try {
      if (guildId) {
        logger.info(`Registering guild-specific commands for guild ${guildId}`);
        await this.rest.put(
          Routes.applicationGuildCommands(
            this.config.discord.clientId,
            guildId
          ),
          { body: Object.values(commands).map((command) => command.data) }
        );
        logger.info(
          `Successfully registered guild-specific commands for guild ${guildId}`
        );
      } else {
        logger.info("Registering global application commands.");
        await this.rest.put(
          Routes.applicationCommands(this.config.discord.clientId),
          { body: Object.values(commands).map((command) => command.data) }
        );
        logger.info("Successfully registered global application commands.");
      }
    } catch (error) {
      logger.error("Error registering commands:", error);
    }
  }

  async unregisterCommands(guildId?: string): Promise<void> {
    try {
      if (guildId) {
        logger.info(
          `Unregistering guild-specific commands for guild ${guildId}.`
        );
        await this.rest.put(
          Routes.applicationGuildCommands(
            this.config.discord.clientId,
            guildId
          ),
          { body: [] }
        );
        logger.info(
          `Successfully unregistered guild-specific commands for guild ${guildId}.`
        );
      } else {
        logger.info("Unregistering global application commands.");
        await this.rest.put(
          Routes.applicationCommands(this.config.discord.clientId),
          { body: [] }
        );
        logger.info("Successfully unregistered global application commands.");
      }
    } catch (error) {
      logger.error("Error unregistering commands:", error);
    }
  }
}
