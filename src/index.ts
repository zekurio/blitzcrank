import { config } from "./config";
import { ClientWrapper } from "./discord/client";
import logger from "./logger";
import WebhookHandler from "./webhook/webhook";

const client = new ClientWrapper(config);

async function cleanUp() {
  const guilds = client.getClient().guilds.cache;

  for (const [guildId, guild] of guilds) {
    try {
      await client.unregisterCommands(guildId);
      logger.info(
        `Unregistered commands for guild: ${guild.name} (${guildId})`
      );
    } catch (error) {
      logger.error(
        `Failed to unregister commands for guild: ${guild.name} (${guildId})`,
        error
      );
    }
  }
}

async function main() {
  await cleanUp().then(async () => {
    await client.login().then(() => {
      const webhookHandler = new WebhookHandler(config, client.getClient());
      webhookHandler.start();
      logger.info("Bot is running");
    });
  });
}

main();
