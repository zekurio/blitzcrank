import {
  EmbedBuilder,
  type Interaction,
  GuildMember,
  PermissionFlagsBits,
  ButtonInteraction,
} from "discord.js";
import { commands } from "../commands";
import { Colors } from "../../static";
import type { ClientWrapper } from "../client";
import logger from "../../logger";
import { jellyseerrClient } from "../../clients/jellyseerr/jellyseerr";

const handleButtonInteraction = async (interaction: ButtonInteraction) => {
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
    const message = await interaction.message.fetch();
    const embed = message.embeds[0];
    const newEmbed = EmbedBuilder.from(embed);

    if (action === "accept") {
      await jellyseerrClient.approveRequest(parseInt(requestId));
      newEmbed
        .setColor(Colors.JELLYSEERR.APPROVED)
        .setTitle(embed.title)
        .setAuthor(null)
        .setFields(
          embed.fields.map((field) =>
            field.name === "Status"
              ? { name: "Status", value: "Approved", inline: true }
              : field
          )
        );
    } else {
      await jellyseerrClient.declineRequest(parseInt(requestId));
      newEmbed
        .setColor(Colors.JELLYSEERR.DECLINED)
        .setTitle(embed.title)
        .setAuthor(null)
        .setFields(
          embed.fields.map((field) =>
            field.name === "Status"
              ? { name: "Status", value: "Declined", inline: true }
              : field
          )
        );
    }

    await interaction.update({
      embeds: [newEmbed],
      components: [],
    });
  } catch (error) {
    await interaction.reply({
      content: "An error occurred while processing your request.",
      ephemeral: true,
    });
  }
};

export const interactionCreateEventHandler = (wrapped: ClientWrapper) => {
  wrapped
    .getClient()
    .on("interactionCreate", async (interaction: Interaction) => {
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
