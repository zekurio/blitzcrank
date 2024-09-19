import logger from "../../logger";
import type { ClientWrapper } from "../client";

export const readyEventHandler = (wrapped: ClientWrapper) => {
  const client = wrapped.getClient();

  client.on("ready", async () => {
    logger.info(`Bot logged in`, {
      username: client.user?.username,
      id: client.user?.id,
    });

    const guilds = client.guilds.cache;
    logger.info(`Registering commands for ${guilds.size} guilds`);

    for (const [guildId, guild] of guilds) {
      try {
        await wrapped.registerCommands(guildId);
        logger.info(
          `Registered commands for guild: ${guild.name} (${guildId})`
        );
      } catch (error) {
        logger.error(
          `Failed to register commands for guild: ${guild.name} (${guildId})`,
          error
        );
      }
    }

    logger.info("Finished registering commands");
  });
};
