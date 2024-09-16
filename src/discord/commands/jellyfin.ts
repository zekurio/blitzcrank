import { SlashCommandBuilder } from "@discordjs/builders";
import {
  ActionRowBuilder,
  AutocompleteInteraction,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { Colors } from "../../static";
import logger from "../../logger";
import {
  getAllLibraries,
  getItemDetails,
  getItemImageUrl,
  getLibraryItemCount,
  getLibraryItems,
} from "../../clients/jellyfin";
import { ImageType } from "@jellyfin/sdk/lib/generated-client";

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
  const subcommand = interaction.options.getSubcommand();
  const focusedValue = interaction.options.getFocused().toLowerCase();

  if (subcommand === "media") {
    const libraries = await getAllLibraries();
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
    const libraries = await getAllLibraries();
    for (const library of libraries) {
      const items = await getLibraryItems(library.Id ?? "", false);
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
    switch (subcommand) {
      case "libraries":
        await handleLibrariesCommand(interaction);
        break;
      case "media":
        await handleMediaCommand(interaction);
        break;
      default:
        logger.warn(`Unknown subcommand: ${subcommand}`);
        await interaction.reply({
          content: "Unknown subcommand",
          ephemeral: true,
        });
    }
  } else if (subcommand === "info") {
    await handleInfoCommand(interaction);
  } else {
    logger.warn(`Unknown command: ${subcommand}`);
    await interaction.reply({ content: "Unknown command", ephemeral: true });
  }
}

async function handleLibrariesCommand(
  interaction: ChatInputCommandInteraction
) {
  await interaction.deferReply();

  try {
    const libraries = await getAllLibraries();

    if (libraries.length === 0) {
      logger.info("No libraries found in Jellyfin.");
      await interaction.editReply("No libraries found in Jellyfin.");
      return;
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
      const itemCount = await getLibraryItemCount(library.Id ?? "");
      embed.addFields({
        name: `${library.Name}`,
        value: `Type: ${
          library.CollectionType || "Unknown"
        }\nItems: ${itemCount}`,
        inline: true,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    logger.error("Error fetching Jellyfin libraries:", error);
    const errorEmbed = new EmbedBuilder()
      .setColor(Colors.ERROR)
      .setTitle("Error")
      .setDescription("An error occurred while fetching Jellyfin libraries.")
      .addFields({
        name: "Error Details",
        value: `\`\`\`\n${error}\n\`\`\``,
      });
    await interaction.editReply({ embeds: [errorEmbed] });
  }
}

async function handleMediaCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const libraryId = interaction.options.getString("library");
  if (!libraryId) {
    logger.warn("No library ID provided for media command.");
    await interaction.editReply("No library ID provided.");
    return;
  }

  const itemsPerPage = 24;
  let currentPage = 0;

  async function fetchAndDisplayItems(page: number) {
    try {
      if (libraryId === null) {
        throw new Error("Library ID is null");
      }
      const items = await getLibraryItems(libraryId, false);
      const totalRecordCount = items.length;
      const startIndex = page * itemsPerPage;
      const endIndex = Math.min(startIndex + itemsPerPage, totalRecordCount);
      const pageItems = items.slice(startIndex, endIndex);

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
    } catch (error) {
      logger.error("Error fetching library items:", error);
      const errorEmbed = new EmbedBuilder()
        .setColor(Colors.ERROR)
        .setTitle("Error")
        .setDescription("An error occurred while fetching library items.")
        .addFields({
          name: "Error Details",
          value: `\`\`\`\n${error}\n\`\`\``,
        });
      return { embeds: [errorEmbed], components: [] };
    }
  }

  const initialMessage = await fetchAndDisplayItems(currentPage);
  const message = await interaction.editReply(initialMessage);

  const collector = message.createMessageComponentCollector({ time: 60000 });

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

async function handleInfoCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const itemId = interaction.options.getString("item");
  if (!itemId) {
    logger.warn("No item ID provided for info command.");
    await interaction.editReply("No item ID provided.");
    return;
  }

  try {
    const itemDetails = await getItemDetails(itemId);

    if (!itemDetails) {
      await interaction.editReply("Item not found.");
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(Colors.JELLYFIN_PURPLE)
      .setTitle(itemDetails.Name ?? "Unknown Title")
      .setDescription(itemDetails.Overview ?? "No overview available.")
      .setTimestamp()
      .setFooter({
        text: `Requested by ${interaction.user.tag}`,
        iconURL: interaction.user.displayAvatarURL(),
      });

    const imageUrl = await getItemImageUrl(itemId);
    embed.setImage(imageUrl);

    if (itemDetails.ProductionYear) {
      embed.addFields({
        name: "Year",
        value: itemDetails.ProductionYear.toString(),
        inline: true,
      });
    }

    if (itemDetails.OfficialRating) {
      embed.addFields({
        name: "Rating",
        value: itemDetails.OfficialRating,
        inline: true,
      });
    }

    if (itemDetails.CommunityRating) {
      embed.addFields({
        name: "Community Rating",
        value: itemDetails.CommunityRating.toFixed(1),
        inline: true,
      });
    }

    if (itemDetails.Genres && itemDetails.Genres.length > 0) {
      embed.addFields({
        name: "Genres",
        value: itemDetails.Genres.join(", "),
        inline: false,
      });
    }

    if (itemDetails.Studios && itemDetails.Studios.length > 0) {
      embed.addFields({
        name: "Studios",
        value: itemDetails.Studios.map((studio) => studio.Name).join(", "),
        inline: false,
      });
    }

    if (itemDetails.Type === "Series") {
      embed.addFields({ name: "Type", value: "TV Series", inline: true });
      if (itemDetails.ChildCount) {
        embed.addFields({
          name: "Seasons",
          value: itemDetails.ChildCount.toString(),
          inline: true,
        });
      }
    } else if (itemDetails.Type === "Movie") {
      embed.addFields({ name: "Type", value: "Movie", inline: true });
      if (itemDetails.RunTimeTicks) {
        const runtime = Math.floor(itemDetails.RunTimeTicks / (10000000 * 60));
        embed.addFields({
          name: "Runtime",
          value: `${runtime} minutes`,
          inline: true,
        });
      }
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    logger.error("Error fetching item details:", error);
    const errorEmbed = new EmbedBuilder()
      .setColor(Colors.ERROR)
      .setTitle("Error")
      .setDescription("An error occurred while fetching item details.")
      .addFields({
        name: "Error Details",
        value: `\`\`\`\n${error}\n\`\`\``,
      });
    await interaction.editReply({ embeds: [errorEmbed] });
  }
}
