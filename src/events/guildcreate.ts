import { Guild } from "discord.js";
import { registerCommands } from "../utils/commands";
import logger from "../logger";

export const guildCreateEventHandler = (guild: Guild) => {
  try {
    registerCommands(guild.id);
    logger.info(
      `Registered commands for new guild: ${guild.name} (${guild.id})`
    );
  } catch (error) {
    logger.error(
      `Failed to register commands for new guild: ${guild.name} (${guild.id})`,
      error
    );
  }
};
