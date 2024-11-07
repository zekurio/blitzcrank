import type { ChatInputCommandInteraction } from "discord.js";
import { handleAddEmoteCommand } from "./add";

export async function handleEmoteCommandGroup(
  interaction: ChatInputCommandInteraction
) {
  const subcommand = interaction.options.getSubcommand();
  switch (subcommand) {
    case "add":
      return handleAddEmoteCommand(interaction);
  }
}
