import { REST, Routes } from "discord.js";
import { config } from "./config";
import { commands } from "./commands";
import logger from "./logger";

const commandsData = Object.values(commands).map((command) => command.data);

const rest = new REST({ version: "10" }).setToken(config.discord.token);

type RegisterCommandsProps = {
  guildId: string;
};

export async function registerCommands({ guildId }: RegisterCommandsProps) {
  try {
    logger.info("Registering application commands.");

    await rest.put(
      Routes.applicationGuildCommands(config.discord.clientId, guildId),
      {
        body: commandsData,
      }
    );

    logger.info("Successfully registered application commands.");
  } catch (error) {
    logger.error("Error registering application commands.", error);
  }
}
