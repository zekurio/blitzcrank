import type { ChatInputCommandInteraction } from "discord.js";

export async function handleSetupCommand(
  interaction: ChatInputCommandInteraction
) {
  await interaction.deferReply({ ephemeral: true });
}
