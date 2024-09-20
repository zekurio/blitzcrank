import { GuildMember, PermissionFlagsBits } from "discord.js";
import { jellyseerrClient } from "../clients/jellyseerr/jellyseerr";
import type { ButtonHandlerFunction } from "../utils/buttonhandler";
import { updateEmbed } from "./webhook";
import { Colors } from "../static";

export const handleAccept: ButtonHandlerFunction = async (
  interaction,
  requestId
) => {
  const member = interaction.member as GuildMember;
  if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: "You don't have permission to perform this action.",
      ephemeral: true,
    });
    return;
  }

  try {
    await jellyseerrClient.approveRequest(parseInt(requestId));
    await updateEmbed(interaction, Colors.JELLYSEERR.APPROVED, "Approved");
  } catch (error) {
    await interaction.reply({
      content: "An error occurred while processing your request.",
      ephemeral: true,
    });
  }
};

export const handleDecline: ButtonHandlerFunction = async (
  interaction,
  requestId
) => {
  const member = interaction.member as GuildMember;
  if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: "You don't have permission to perform this action.",
      ephemeral: true,
    });
    return;
  }

  try {
    await jellyseerrClient.declineRequest(parseInt(requestId));
    await updateEmbed(interaction, Colors.JELLYSEERR.DECLINED, "Declined");
  } catch (error) {
    await interaction.reply({
      content: "An error occurred while processing your request.",
      ephemeral: true,
    });
  }
};
