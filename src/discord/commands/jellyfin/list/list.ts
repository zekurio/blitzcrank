import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { Colors } from "../../../../static";
import { jellyfinClient } from "../../../../clients/jellyfin/jellyfin";
import { handleMediaCommand } from "./media";
import { handleLibrariesCommand } from "./libraries";

export async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case "libraries":
      await handleLibrariesCommand(interaction);
      break;
    case "media":
      await handleMediaCommand(interaction);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}
