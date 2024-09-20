import { ChatInputCommandInteraction } from "discord.js";
import { handleListCommand } from "./list";

export async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "list") {
    await handleListCommand(interaction);
  } else {
    throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}
