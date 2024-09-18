import { ChatInputCommandInteraction } from "discord.js";
import { execute as executeList } from "./list";

export async function execute(
  interaction: ChatInputCommandInteraction,
  subcommand: string
) {
  switch (subcommand) {
    case "list":
      await executeList(interaction);
      break;
    default:
      await interaction.reply({
        content: "Unknown subcommand",
        ephemeral: true,
      });
  }
}
