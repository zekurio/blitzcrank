import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { Colors } from "../../../static";
import { jellyfinClient } from "../../../clients/jellyfin/jellyfin";

export async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case "libraries":
      await handleLibrariesCommand(interaction);
      break;
    case "media":
      await handleMediaCommand(interaction);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

async function handleLibrariesCommand(
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
    const itemCount = await jellyfinClient.getLibraryItemCount(
      library.Id ?? ""
    );
    embed.addFields({
      name: `${library.Name}`,
      value: `Type: ${
        library.CollectionType || "Unknown"
      }\nItems: ${itemCount}`,
      inline: true,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleMediaCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const libraryId = interaction.options.getString("library");
  if (!libraryId) {
    await interaction.editReply("No library ID provided.");
    return;
  }

  const itemsPerPage = 6;
  let currentPage = 0;

  async function fetchAndDisplayItems(page: number) {
    if (libraryId === null) {
      throw new Error("Library ID is null");
    }
    const items = await jellyfinClient.getLibraryItems(libraryId, false);
    const totalRecordCount = items.length;
    const startIndex = page * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, totalRecordCount);
    const pageItems = items.slice(startIndex, endIndex);

    if (pageItems.length === 0) {
      const errorEmbed = new EmbedBuilder()
        .setColor(Colors.WARNING)
        .setTitle("Jellyfin Library Items")
        .setDescription("No items to display");

      return { embeds: [errorEmbed], components: [] };
    }
    const embed = new EmbedBuilder()
      .setColor(Colors.JELLYFIN_PURPLE)
      .setTitle("Jellyfin Library Items")
      .setFooter({
        text: `Page ${page + 1}/${Math.ceil(
          totalRecordCount / itemsPerPage
        )} • Total items: ${totalRecordCount}`,
        iconURL: interaction.user.displayAvatarURL(),
      });

    for (const item of pageItems) {
      embed.addFields({
        name: item.Name ?? "Unknown",
        value: `Type: ${item.Type}\nYear: ${item.ProductionYear || "N/A"}`,
        inline: true,
      });
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("previous")
        .setLabel("Previous")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId("next")
        .setLabel("Next")
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
