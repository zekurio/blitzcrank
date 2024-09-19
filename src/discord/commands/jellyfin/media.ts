import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { jellyfinClient } from "../../../clients/jellyfin/jellyfin";
import { Colors } from "../../../static";
import { getLocalization } from "../../../localization/localization";

export async function handleMediaCommand(
  interaction: ChatInputCommandInteraction
) {
  await interaction.deferReply({ ephemeral: true });

  const lang = interaction.locale || "en";
  const libraryId = interaction.options.getString("library") || "all";

  const itemsPerPage = 24;
  let currentPage = 0;

  async function fetchAndDisplayItems(page: number) {
    let items;
    if (libraryId === "all") {
      const libraries = await jellyfinClient.getAllLibraries();
      items = (
        await Promise.all(
          libraries.map((lib) =>
            jellyfinClient.getLibraryItems(lib.Id ?? "", false)
          )
        )
      ).flat();
    } else {
      items = await jellyfinClient.getLibraryItems(libraryId, false);
    }

    const totalRecordCount = items.length;
    const startIndex = page * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, totalRecordCount);
    const pageItems = items.slice(startIndex, endIndex);

    if (pageItems.length === 0) {
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

      return { embeds: [errorEmbed], components: [] };
    }

    const embed = new EmbedBuilder()
      .setColor(Colors.JELLYFIN_PURPLE)
      .setTitle(getLocalization("jellyfin.media.embeds.reply.title", lang))
      .setFooter({
        text: getLocalization("jellyfin.media.embeds.reply.footer", lang, {
          currentPage: (page + 1).toString(),
          totalPages: Math.ceil(totalRecordCount / itemsPerPage).toString(),
          totalItems: totalRecordCount.toString(),
        }),
        iconURL: interaction.user.displayAvatarURL(),
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

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("previous")
        .setLabel(getLocalization("jellyfin.media.components.previous", lang))
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId("next")
        .setLabel(getLocalization("jellyfin.media.components.next", lang))
        .setStyle(ButtonStyle.Primary)
        .setDisabled(endIndex >= totalRecordCount)
    );

    return { embeds: [embed], components: [row] };
  }

  const initialMessage = await fetchAndDisplayItems(currentPage);
  const message = await interaction.editReply(initialMessage);

  const collector = message.createMessageComponentCollector({ time: 60000 });

  collector.on("collect", () => {
    collector.resetTimer();
  });

  collector.on("collect", async (i) => {
    if (i.customId === "previous") {
      currentPage--;
    } else if (i.customId === "next") {
      currentPage++;
    }

    await i.update(await fetchAndDisplayItems(currentPage));
  });

  collector.on("end", () => {
    interaction.editReply({ components: [] });
  });
}
