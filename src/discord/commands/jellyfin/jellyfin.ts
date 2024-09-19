import { SlashCommandBuilder } from "@discordjs/builders";
import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
} from "discord.js";
import { jellyfinClient } from "../../../clients/jellyfin/jellyfin";
import { handleAboutCommand } from "./about";
import { handleMediaCommand } from "./media";
import { getLocalization } from "../../../localization/localization";

export const data = new SlashCommandBuilder()
  .setName(getLocalization("jellyfin.name"))
  .setDescription(getLocalization("jellyfin.description"))
  .setNameLocalizations({
    de: getLocalization("jellyfin.name", "de"),
  })
  .setDescriptionLocalizations({
    de: getLocalization("jellyfin.description", "de"),
  })
  .addSubcommand((subcommand) =>
    subcommand
      .setName(getLocalization("jellyfin.about.name"))
      .setDescription(getLocalization("jellyfin.about.description"))
      .setNameLocalizations({
        de: getLocalization("jellyfin.about.name", "de"),
      })
      .setDescriptionLocalizations({
        de: getLocalization("jellyfin.about.description", "de"),
      })
      .addStringOption((option) =>
        option
          .setName(getLocalization("jellyfin.about.options.item.name"))
          .setNameLocalizations({
            de: getLocalization("jellyfin.about.options.item.name", "de"),
          })
          .setDescription(
            getLocalization("jellyfin.about.options.item.description")
          )
          .setDescriptionLocalizations({
            de: getLocalization(
              "jellyfin.about.options.item.description",
              "de"
            ),
          })
          .setRequired(true)
          .setAutocomplete(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName(getLocalization("jellyfin.media.name"))
      .setDescription(getLocalization("jellyfin.media.description"))
      .setNameLocalizations({
        de: getLocalization("jellyfin.media.name", "de"),
      })
      .setDescriptionLocalizations({
        de: getLocalization("jellyfin.media.description", "de"),
      })
      .addStringOption((option) =>
        option
          .setName(getLocalization("jellyfin.media.options.library.name"))
          .setNameLocalizations({
            de: getLocalization("jellyfin.media.options.library.name", "de"),
          })
          .setDescription(
            getLocalization("jellyfin.media.options.library.description")
          )
          .setDescriptionLocalizations({
            de: getLocalization(
              "jellyfin.media.options.library.description",
              "de"
            ),
          })
          .setRequired(false)
          .setAutocomplete(true)
      )
  );

export async function autocomplete(interaction: AutocompleteInteraction) {
  const subcommand = interaction.options.getSubcommand();
  const focusedValue = interaction.options.getFocused().toLowerCase();

  if (subcommand === "media") {
    const libraries = await jellyfinClient.getAllLibraries();
    const choices = [
      {
        name: getLocalization(
          "jellyfin.media.options.library.all",
          interaction.locale
        ),
        value: "all",
      },
      ...libraries.map((lib) => ({
        name: lib.Name ?? "",
        value: lib.Id ?? "",
      })),
    ];
    const filtered = choices.filter((choice) =>
      choice.name.toLowerCase().includes(focusedValue)
    );
    await interaction.respond(
      filtered.slice(0, 25).map(({ name, value }) => ({ name, value }))
    );
  } else if (subcommand === "about") {
    const choices = [];
    const libraries = await jellyfinClient.getAllLibraries();
    for (const library of libraries) {
      const items = await jellyfinClient.getLibraryItems(
        library.Id ?? "",
        false
      );
      for (const item of items) {
        choices.push({
          name: item.Name ?? "",
          value: item.Id ?? "",
        });
      }
    }

    const filtered = choices.filter((choice) =>
      choice.name.toLowerCase().includes(focusedValue)
    );
    await interaction.respond(filtered.slice(0, 25));
  }
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "media") {
    await handleMediaCommand(interaction);
  } else if (subcommand === "about") {
    await handleAboutCommand(interaction);
  } else {
    throw new Error(`Unknown command: ${subcommand}`);
  }
}
