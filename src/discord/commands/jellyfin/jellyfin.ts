import { SlashCommandBuilder } from "@discordjs/builders";
import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
} from "discord.js";
import { jellyfinClient } from "../../../clients/jellyfin/jellyfin";
import { execute as executeInfo } from "./info";
import { execute as executeList } from "./list";

export const data = new SlashCommandBuilder()
  .setName("jellyfin")
  .setDescription("Jellyfin related commands")
  .addSubcommandGroup((group) =>
    group
      .setName("list")
      .setDescription("List Jellyfin libraries or media")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("libraries")
          .setDescription("List all Jellyfin libraries")
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("media")
          .setDescription("List all media from a Jellyfin library")
          .addStringOption((option) =>
            option
              .setName("library")
              .setDescription("The library to list media from")
              .setRequired(true)
              .setAutocomplete(true)
          )
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("info")
      .setDescription("Display information about a movie or show")
      .addStringOption((option) =>
        option
          .setName("item")
          .setDescription("The movie or show to display information about")
          .setRequired(true)
          .setAutocomplete(true)
      )
  );

export async function autocomplete(interaction: AutocompleteInteraction) {
  const subcommandGroup = interaction.options.getSubcommandGroup();
  const subcommand = interaction.options.getSubcommand();
  const focusedValue = interaction.options.getFocused().toLowerCase();

  if (subcommandGroup === "list" && subcommand === "media") {
    const libraries = await jellyfinClient.getAllLibraries();
    const choices = libraries.map((lib) => ({
      name: lib.Name ?? "",
      value: lib.Id ?? "",
    }));
    const filtered = choices.filter((choice) =>
      choice.name.toLowerCase().includes(focusedValue)
    );
    await interaction.respond(
      filtered.slice(0, 25).map(({ name, value }) => ({ name, value }))
    );
  } else if (subcommand === "info") {
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
  const subcommandGroup = interaction.options.getSubcommandGroup();
  const subcommand = interaction.options.getSubcommand();

  if (subcommandGroup === "list") {
    await executeList(interaction);
  } else if (subcommand === "info") {
    await executeInfo(interaction);
  } else {
    throw new Error(`Unknown command: ${subcommand}`);
  }
}
