import { EmbedBuilder } from "discord.js";
import { commands } from "../commands";
import { Colors } from "../../static";
import type { ClientWrapper } from "../client";
import logger from "../../logger";

export const interactionCreateEventHandler = (wrapped: ClientWrapper) => {
  wrapped.getClient().on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;
        if (commands[commandName as keyof typeof commands]) {
          await commands[commandName as keyof typeof commands].execute(
            interaction
          );
        }
      } else if (interaction.isAutocomplete()) {
        const { commandName } = interaction;
        if (commandName in commands) {
          const command = commands[commandName as keyof typeof commands];
          if (
            "autocomplete" in command &&
            typeof command.autocomplete === "function"
          ) {
            await command.autocomplete(interaction);
          }
        }
      }
    } catch (error) {
      logger.error(`Error handling interaction: ${error}`);
      if (interaction.isRepliable()) {
        const errorEmbed = new EmbedBuilder()
          .setColor(Colors.ERROR)
          .setTitle("Error")
          .setDescription("An error occurred while processing your request.")
          .addFields({ name: "Error Details", value: `${error}` });

        await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
      }
    }
  });
};
