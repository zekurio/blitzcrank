import { SlashCommandBuilder } from "@discordjs/builders";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { jellyseerrClient } from "../../clients/jellyseerr/jellyseerr";
import { Colors } from "../../static";
import logger from "../../logger";

export const data = new SlashCommandBuilder()
  .setName("jellyseerr")
  .setDescription("Interact with Jellyseerr")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("requests")
      .setDescription("List jellyseerr requests")
      .addStringOption((option) =>
        option
          .setName("status")
          .setDescription("Status of the requests")
          .setRequired(true)
          .addChoices(
            { name: "All", value: "all" },
            { name: "Available", value: "available" },
            { name: "Unavailable", value: "unavailable" },
            { name: "Approved", value: "approved" },
            { name: "Pending", value: "pending" },
            { name: "Processing", value: "processing" }
          )
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case "requests":
      await handleRequestSubcommand(interaction);
      break;
    default:
      await interaction.reply({
        content: "Unknown subcommand",
        ephemeral: true,
      });
  }
}

async function handleRequestSubcommand(
  interaction: ChatInputCommandInteraction
) {
  await interaction.deferReply();

  const status = interaction.options.getString("status");
  if (!status) {
    await interaction.editReply("No status provided.");
    return;
  }

  const itemsPerPage = 1;
  let currentPage = 0;

  async function fetchAndDisplayItems(page: number) {
    if (status === null) {
      throw new Error("Status is null");
    }

    const requests = await jellyseerrClient.getRequests(
      itemsPerPage,
      page * itemsPerPage,
      status as
        | "all"
        | "available"
        | "unavailable"
        | "approved"
        | "pending"
        | "processing"
    );

    if (requests.results.length === 0) {
      const errorEmbed = new EmbedBuilder()
        .setColor(Colors.WARNING)
        .setTitle("Jellyseerr Requests")
        .setDescription("No requests to display");

      return { embeds: [errorEmbed], components: [] };
    }

    const embed = new EmbedBuilder()
      .setColor(Colors.JELLYSEERR_PURPLE)
      .setTitle("Jellyseerr Requests")
      .setFooter({
        text: `Page ${page + 1}/${Math.ceil(
          requests.pageInfo.results / itemsPerPage
        )} • Total requests: ${requests.pageInfo.results}`,
        iconURL: interaction.user.displayAvatarURL(),
      });

    for (const request of requests.results) {
      let mediaDetails;
      if (request.media.mediaType === "movie") {
        mediaDetails = await jellyseerrClient.getMovieDetails(
          request.media.tmdbId
        );
      } else {
        mediaDetails = await jellyseerrClient.getTvDetails(
          request.media.tmdbId
        );
      }
      let mediaTitle = mediaDetails
        ? "title" in mediaDetails
          ? mediaDetails.title
          : mediaDetails.name
        : "Unknown Title";
      let mediaType = request.media.mediaType;
      mediaType = mediaType.charAt(0).toUpperCase() + mediaType.slice(1);
      let requestedBy = request.requestedBy.displayName;
      let requestStatus = getStatusString(request.status);

      embed.addFields(
        { name: "Title", value: mediaTitle, inline: true },
        { name: "Type", value: mediaType, inline: true },
        { name: "Requested by", value: requestedBy, inline: true },
        { name: "Status", value: requestStatus, inline: true },
        {
          name: "Created At",
          value: new Date(request.createdAt).toLocaleString(),
          inline: true,
        },
        {
          name: "Updated At",
          value: new Date(request.updatedAt).toLocaleString(),
          inline: true,
        }
      );

      // if status is available, add the stream link to jellyfin
      if (request.status === 2) {
        embed.addFields({
          name: "Stream Link",
          value: `[Click here to stream](${request.media.mediaUrl})`,
        });
      }

      if (mediaDetails && mediaDetails.overview) {
        embed.addFields({
          name: "Overview",
          value: mediaDetails.overview.slice(0, 1024),
        });
      }

      if (mediaDetails && mediaDetails.posterPath) {
        embed.setThumbnail(
          `https://image.tmdb.org/t/p/original${mediaDetails.posterPath}`
        );
      }
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
        .setDisabled(
          page >= Math.ceil(requests.pageInfo.results / itemsPerPage) - 1
        )
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

function getStatusString(status: number): string {
  switch (status) {
    case 2:
      return "Available";
    default:
      return "Unknown";
  }
}
