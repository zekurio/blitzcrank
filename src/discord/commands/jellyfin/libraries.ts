import { ChatInputCommandInteraction, EmbedBuilder } from "discord.js";
import { jellyfinClient } from "../../../clients/jellyfin/jellyfin";
import { Colors } from "../../../static";
import { getLocalization } from "../../../localization/localization";

export async function handleLibrariesCommand(
  interaction: ChatInputCommandInteraction
) {
  await interaction.deferReply();

  const lang = interaction.locale || "en";

  const libraries = await jellyfinClient.getAllLibraries();

  if (libraries.length === 0) {
    const errorEmbed = new EmbedBuilder()
      .setColor(Colors.WARNING)
      .setTitle(
        getLocalization("jellyfin.list.libraries.noLibrariesFound", lang)
      )
      .setDescription(
        getLocalization("jellyfin.list.libraries.noLibrariesFound", lang)
      );

    return { embeds: [errorEmbed], components: [] };
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.JELLYFIN_PURPLE)
    .setTitle(getLocalization("jellyfin.list.libraries.title", lang))
    .setTimestamp()
    .setFooter({
      text: getLocalization("jellyfin.list.libraries.requestedBy", lang, {
        user: interaction.user.tag,
      }),
      iconURL: interaction.user.displayAvatarURL(),
    });

  for (const library of libraries) {
    let itemCount: number;
    let libraryType: string;

    if (library.CollectionType === "movies") {
      libraryType = getLocalization("jellyfin.info.movie", lang);
      itemCount = await jellyfinClient.getLibraryItemCount(library.Id ?? "");
    } else if (library.CollectionType === "tvshows") {
      libraryType = getLocalization("jellyfin.info.tvSeries", lang);
      itemCount = await jellyfinClient.getLibraryShowCount(library.Id ?? "");
    } else {
      libraryType =
        library.CollectionType ||
        getLocalization("jellyfin.info.unknownTitle", lang);
      itemCount = await jellyfinClient.getLibraryItemCount(library.Id ?? "");
    }

    embed.addFields({
      name: `${library.Name}`,
      value: `${getLocalization(
        "jellyfin.list.libraries.type",
        lang
      )}: ${libraryType}\n${getLocalization(
        "jellyfin.list.libraries.items",
        lang
      )}: ${itemCount}`,
      inline: true,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}
