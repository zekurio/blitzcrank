import { config } from "./config";
import { ClientWrapper } from "./discord/client";
import logger from "./logger";
import WebhookHandler from "./webhook/webhook";
import {
  ButtonInteraction,
  Events,
  GuildMember,
  PermissionFlagsBits,
} from "discord.js";
import { jellyseerrClient } from "./clients/jellyseerr/jellyseerr";

const wrapped = new ClientWrapper(config);

wrapped
  .login()
  .then(() => {
    logger.info("Bot started successfully");

    const webhookHandler = new WebhookHandler(config, wrapped.getClient());
    webhookHandler.start();

    const gracefulShutdown = async (signal: string) => {
      logger.info(`Received ${signal}. Shutting down gracefully...`);
      try {
        await wrapped.destroy();
        logger.info("Bot has been successfully shut down");
      } catch (error) {
        logger.error("Error during shutdown:", error);
      }
      process.exit();
    };

    ["SIGTERM", "SIGINT", "SIGHUP"].forEach((signal) =>
      process.on(signal, () => gracefulShutdown(signal))
    );

    wrapped.getClient().on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isButton()) return;

      const [action, requestId] = interaction.customId.split("_");

      if (action !== "accept" && action !== "decline") return;

      const member = interaction.member as GuildMember;
      if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({
          content: "You don't have permission to perform this action.",
          ephemeral: true,
        });
        return;
      }

      try {
        if (action === "accept") {
          await jellyseerrClient.approveRequest(parseInt(requestId));
          await interaction.update({
            content: "Request approved!",
            components: [],
          });
        } else {
          await jellyseerrClient.declineRequest(parseInt(requestId));
          await interaction.update({
            content: "Request declined!",
            components: [],
          });
        }
      } catch (error) {
        await interaction.reply({
          content: "An error occurred while processing your request.",
          ephemeral: true,
        });
      }
    });
  })
  .catch((error) => {
    logger.error("Failed to start the bot:", error);
    process.exit(1);
  });
