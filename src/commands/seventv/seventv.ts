import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { handleAddCommand } from "./add";

export const data = new SlashCommandBuilder()
  .setName("seventv")
  .setDescription("Manage 7TV emotes")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("add")
      .setDescription("Add a new emote")
      .addStringOption((option) =>
        option
          .setName("url")
          .setDescription("URL of the emote to add")
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription("Name of the emote to add")
          .setRequired(true)
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "add") {
    await handleAddCommand(interaction);
  }
}
