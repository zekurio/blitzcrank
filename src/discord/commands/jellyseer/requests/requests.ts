import { ChatInputCommandInteraction } from "discord.js";
import { execute as executeList } from "./list";

export async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "list") {
    await executeList(interaction);
  } else {
    throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}
