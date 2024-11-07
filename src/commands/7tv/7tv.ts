import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { handleSetupCommand } from "./setup";
import { handleEmoteCommandGroup } from "./emote/emote";

export const data = new SlashCommandBuilder()
  .setName("7tv")
  .setDescription("Manage 7TV emotes")
  .addSubcommand((subcommand) =>
    subcommand.setName("setup").setDescription("Setup 7TV integration")
  )
  .addSubcommandGroup((group) =>
    group
      .setName("emote")
      .setDescription("Manage emotes")
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
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();
  const subcommandGroup = interaction.options.getSubcommandGroup();
  if (subcommandGroup) {
    if (subcommandGroup === "emote") {
      await handleEmoteCommandGroup(interaction);
    }
  } else {
    if (subcommand === "setup") {
      await handleSetupCommand(interaction);
    }
  }
}
