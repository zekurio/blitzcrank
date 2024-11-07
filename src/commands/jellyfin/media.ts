import {
  ActionRowBuilder,
  ButtonBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { jellyfinClient } from "../../clients/jellyfin/api";
import { Colors } from "../../static";
import { getLocalization } from "../../localization/localization";
import { Paginator, type PaginatorPage } from "../../utils/paginator";

export async function handleMediaCommand(
  interaction: ChatInputCommandInteraction
) {
  await interaction.deferReply({ ephemeral: true });

  const lang = interaction.locale || "en";
  const libraryId = interaction.options.getString("library") || "all";

  const libraries = await jellyfinClient.getAllLibraries();
  const choices = [
    {
      name: getLocalization(
        "jellyfin.media.command.options.library.all",
        interaction.locale
      ),
      value: "all",
    },
    ...libraries.map((lib) => ({
      name: lib.Name ?? "",
      value: lib.Id ?? "",
    })),
  ];

  const libraryName = choices.find(
    (choice) => choice.value === libraryId
  )?.name;

  const itemsPerPage = 6;

  let allItems;
  if (libraryId === "all") {
    const libraries = await jellyfinClient.getAllLibraries();
    allItems = (
      await Promise.all(
        libraries.map((lib) =>
          jellyfinClient.getLibraryItems(lib.Id ?? "", false)
        )
      )
    ).flat();
  } else {
    allItems = await jellyfinClient.getLibraryItems(libraryId, false);
  }

  if (allItems.length === 0) {
    const errorEmbed = new EmbedBuilder()
      .setColor(Colors.WARNING)
      .setTitle(
        getLocalization("jellyfin.media.embeds.noItemsToDisplay.title", lang)
      )
      .setDescription(
        getLocalization(
          "jellyfin.media.embeds.noItemsToDisplay.description",
          lang
        )
      );

    await interaction.editReply({ embeds: [errorEmbed] });
    return;
  }

  const pages: PaginatorPage[] = [];
  for (let i = 0; i < allItems.length; i += itemsPerPage) {
    const pageItems = allItems.slice(i, i + itemsPerPage);
    const embed = new EmbedBuilder()
      .setColor(Colors.JELLYFIN_PURPLE)
      .setTitle(libraryName ?? "")
      .setTimestamp()
      .setAuthor({
        name: getLocalization("jellyfin.media.embeds.reply.author", lang),
      });

    for (const item of pageItems) {
      let typeLocalization = getLocalization(
        "jellyfin.media.embeds.reply.fields.unknownType",
        lang
      );
      if (item.Type === "Movie") {
        typeLocalization = getLocalization(
          "jellyfin.media.embeds.reply.fields.movieType",
          lang
        );
      } else if (item.Type === "Series") {
        typeLocalization = getLocalization(
          "jellyfin.media.embeds.reply.fields.seriesType",
          lang
        );
      }

      embed.addFields({
        name:
          item.Name ??
          getLocalization(
            "jellyfin.media.embeds.reply.fields.unknownTitle",
            lang
          ),
        value: getLocalization(
          "jellyfin.media.embeds.reply.fields.itemDetails",
          lang,
          {
            type: typeLocalization,
            year:
              item.ProductionYear?.toString() ||
              getLocalization(
                "jellyfin.media.embeds.reply.fields.unknownYear",
                lang
              ),
          }
        ),
        inline: true,
      });
    }

    pages.push({
      embed: embed,
      components: [],
    });
  }

  const options = {
    interaction,
    pages,
    totalItems: allItems.length,
  };
  const paginator = new Paginator(options);
  await paginator.start();
}
