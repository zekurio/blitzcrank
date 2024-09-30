import { REST, Routes } from "discord.js";
import { commands } from "../commands";
import logger from "../logger";
import { config } from "../config";

const rest = new REST({ version: "10" }).setToken(config.discord.token);

export async function registerCommands(guildId?: string): Promise<void> {
  try {
    if (guildId) {
      logger.info(`Registering guild-specific commands for guild ${guildId}`);
      await rest.put(
        Routes.applicationGuildCommands(config.discord.clientId, guildId),
        { body: Object.values(commands).map((command) => command.data) }
      );
      logger.info(
        `Successfully registered guild-specific commands for guild ${guildId}`
      );
    } else {
      logger.info("Registering global application commands.");
      await rest.put(Routes.applicationCommands(config.discord.clientId), {
        body: Object.values(commands).map((command) => command.data),
      });
      logger.info("Successfully registered global application commands.");
    }
  } catch (error) {
    logger.error("Error registering commands:", error);
  }
}

export async function unregisterCommands(guildId?: string): Promise<void> {
  try {
    if (guildId) {
      logger.info(
        `Unregistering guild-specific commands for guild ${guildId}.`
      );
      await rest.put(
        Routes.applicationGuildCommands(config.discord.clientId, guildId),
        { body: [] }
      );
      logger.info(
        `Successfully unregistered guild-specific commands for guild ${guildId}.`
      );
    } else {
      logger.info("Unregistering global application commands.");
      await rest.put(Routes.applicationCommands(config.discord.clientId), {
        body: [],
      });
      logger.info("Successfully unregistered global application commands.");
    }
  } catch (error) {
    logger.error("Error unregistering commands:", error);
  }
}
