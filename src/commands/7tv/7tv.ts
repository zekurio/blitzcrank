import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { getLocalization } from "../../localization/localization";
import { handleSetupCommand } from "./setup";
import { handleEmoteCommandGroup } from "./emote/emote";

export const data = new SlashCommandBuilder()
  .setName(getLocalization("7tv.command.name"))
  .setDescription(getLocalization("7tv.command.description"))
  .setNameLocalizations({
    de: getLocalization("7tv.command.name", "de"),
  })
  .setDescriptionLocalizations({
    de: getLocalization("7tv.command.description", "de"),
  })
  .addSubcommand((subcommand) =>
    subcommand
      .setName(getLocalization("7tv.setup.command.name"))
      .setDescription(getLocalization("7tv.setup.command.description"))
      .setNameLocalizations({
        de: getLocalization("7tv.setup.command.name", "de"),
      })
      .setDescriptionLocalizations({
        de: getLocalization("7tv.setup.command.description", "de"),
      })
  )
  .addSubcommandGroup((group) =>
    group
      .setName(getLocalization("7tv.emote.command.name"))
      .setDescription(getLocalization("7tv.emote.command.description"))
      .setNameLocalizations({
        de: getLocalization("7tv.emote.command.name", "de"),
      })
      .setDescriptionLocalizations({
        de: getLocalization("7tv.emote.command.description", "de"),
      })
      .addSubcommand((subcommand) =>
        subcommand
          .setName(getLocalization("7tv.emote.commands.add.name"))
          .setDescription(getLocalization("7tv.emote.commands.add.description"))
          .setNameLocalizations({
            de: getLocalization("7tv.emote.commands.add.name", "de"),
          })
          .setDescriptionLocalizations({
            de: getLocalization("7tv.emote.commands.add.description", "de"),
          })
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
