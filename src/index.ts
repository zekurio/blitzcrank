import { Client } from "discord.js";
import { registerCommands } from "./register";
import { commands } from "./commands";
import { config } from "./config";
import logger from "./logger";
import { PostgresDatabase } from "./database/postgres/postgres";

const client = new Client({
  intents: ["Guilds", "GuildMessages", "DirectMessages"],
});

// Initialize database
const db = new PostgresDatabase(config.postgres.connectionString);

async function main() {
  try {
    // Initialize the database
    await db.init();
    logger.info("Database initialized successfully");

    // Set up Discord client event handlers
    client.once("ready", () => {
      logger.info(`Bot logged in`, {
        username: client.user?.username,
        id: client.user?.id,
      });
    });

    client.on("guildCreate", async (guild) => {
      await registerCommands({ guildId: guild.id });
    });

    client.on("interactionCreate", async (interaction) => {
      if (!interaction.isCommand()) {
        return;
      }
      const { commandName } = interaction;
      if (commands[commandName as keyof typeof commands]) {
        commands[commandName as keyof typeof commands].execute(interaction);
      }
    });

    // Login to Discord
    await client.login(config.discord.token);
  } catch (error) {
    logger.error("Error during initialization", error);
    process.exit(1);
  }
}

main();
