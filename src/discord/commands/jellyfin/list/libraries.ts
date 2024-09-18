import { ChatInputCommandInteraction, EmbedBuilder } from "discord.js";
import { jellyfinClient } from "../../../../clients/jellyfin/jellyfin";
import { Colors } from "../../../../static";

export async function handleLibrariesCommand(
  interaction: ChatInputCommandInteraction
) {
  await interaction.deferReply();

  const libraries = await jellyfinClient.getAllLibraries();

  if (libraries.length === 0) {
    const errorEmbed = new EmbedBuilder()
      .setColor(Colors.WARNING)
      .setTitle("Jellyfin Libraries")
      .setDescription("No libraries found in Jellyfin.");

    return { embeds: [errorEmbed], components: [] };
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.JELLYFIN_PURPLE)
    .setTitle("Jellyfin Libraries")
    .setTimestamp()
    .setFooter({
      text: `Requested by ${interaction.user.tag}`,
      iconURL: interaction.user.displayAvatarURL(),
    });
  for (const library of libraries) {
    let itemCount: number;
    let libraryType: string;

    if (library.CollectionType === "movies") {
      libraryType = "Movies";
      itemCount = await jellyfinClient.getLibraryItemCount(library.Id ?? "");
    } else if (library.CollectionType === "tvshows") {
      libraryType = "Shows";
      itemCount = await jellyfinClient.getLibraryShowCount(library.Id ?? "");
    } else {
      libraryType = library.CollectionType || "Unknown";
      itemCount = await jellyfinClient.getLibraryItemCount(library.Id ?? "");
    }

    embed.addFields({
      name: `${library.Name}`,
      value: `Type: ${libraryType}\nItems: ${itemCount}`,
      inline: true,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}
