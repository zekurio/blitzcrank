import { ChatInputCommandInteraction, EmbedBuilder } from "discord.js";
import { jellyfinClient } from "../../../clients/jellyfin/jellyfin";
import { Colors } from "../../../static";
import { getLocalization } from "../../../localization/localization";

export async function handleLibrariesCommand(
  interaction: ChatInputCommandInteraction
) {
  await interaction.deferReply({ ephemeral: true });

  const lang = interaction.locale || "en";

  const libraries = await jellyfinClient.getAllLibraries();

  if (libraries.length === 0) {
    const errorEmbed = new EmbedBuilder()
      .setColor(Colors.WARNING)
      .setTitle(
        getLocalization(
          "jellyfin.libraries.embeds.noLibrariesFound.title",
          lang
        )
      )
      .setDescription(
        getLocalization(
          "jellyfin.libraries.embeds.noLibrariesFound.description",
          lang
        )
      );

    return { embeds: [errorEmbed], components: [] };
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.JELLYFIN_PURPLE)
    .setTitle(getLocalization("jellyfin.libraries.embeds.reply.title", lang))
    .setTimestamp()
    .setFooter({
      text: getLocalization(
        "jellyfin.libraries.embeds.reply.requestedBy",
        lang,
        {
          user: interaction.user.tag,
        }
      ),
      iconURL: interaction.user.displayAvatarURL(),
    });

  for (const library of libraries) {
    let itemCount: number;
    let libraryType: string;

    if (library.CollectionType === "movies") {
      libraryType = getLocalization(
        "jellyfin.libraries.embeds.reply.fields.movie",
        lang
      );
      itemCount = await jellyfinClient.getLibraryItemCount(library.Id ?? "");
    } else if (library.CollectionType === "tvshows") {
      libraryType = getLocalization(
        "jellyfin.libraries.embeds.reply.fields.tvSeries",
        lang
      );
      itemCount = await jellyfinClient.getLibraryItemCount(
        library.Id ?? "",
        false
      );
    } else {
      libraryType =
        library.CollectionType ||
        getLocalization("jellyfin.libraries.embeds.reply.unknownTitle", lang);
      itemCount = await jellyfinClient.getLibraryItemCount(library.Id ?? "");
    }

    embed.addFields({
      name: `${library.Name}`,
      value: `${getLocalization(
        "jellyfin.libraries.embeds.reply.fields.type",
        lang
      )}: ${libraryType}\n${getLocalization(
        "jellyfin.libraries.embeds.reply.fields.items",
        lang
      )}: ${itemCount}`,
      inline: true,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}
