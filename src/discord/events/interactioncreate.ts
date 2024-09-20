import { EmbedBuilder, type Interaction } from "discord.js";
import { Colors } from "../../static";
import type { ClientWrapper } from "../client";
import logger from "../../logger";
import { handleChatCommand } from "./interactions/chatinputcommandinteraction";
import { handleAutocomplete } from "./interactions/autocompleteinteraction";
import { handleButtonInteraction } from "./interactions/buttoninteraction";

export const interactionCreateEventHandler = (wrapped: ClientWrapper) => {
  wrapped
    .getClient()
    .on("interactionCreate", async (interaction: Interaction) => {
      try {
        if (interaction.isChatInputCommand()) {
          await handleChatCommand(interaction);
        } else if (interaction.isAutocomplete()) {
          await handleAutocomplete(interaction);
        } else if (interaction.isButton()) {
          await handleButtonInteraction(interaction);
        }
      } catch (error) {
        logger.error(`Error handling interaction: ${error}`);
        if (interaction.isRepliable()) {
          const errorEmbed = new EmbedBuilder()
            .setColor(Colors.ERROR)
            .setTitle("Error")
            .setDescription("An error occurred while processing your request.")
            .addFields({ name: "Error Details", value: `${error}` });

          try {
            if (!interaction.replied && !interaction.deferred) {
              await interaction.reply({
                embeds: [errorEmbed],
                ephemeral: true,
              });
            } else if (interaction.deferred) {
              await interaction.editReply({ embeds: [errorEmbed] });
            } else {
              await interaction.followUp({
                embeds: [errorEmbed],
                ephemeral: true,
              });
            }
          } catch (replyError) {
            logger.error(`Failed to send error message: ${replyError}`);
          }
        }
      }
    });
};
