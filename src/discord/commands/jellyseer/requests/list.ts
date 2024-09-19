import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { jellyseerrClient } from "../../../../clients/jellyseerr/jellyseerr";
import { Colors } from "../../../../static";
import type { RequestStatus } from "../../../../clients/jellyseerr/models";

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const status = interaction.options.getString("status") as RequestStatus;
  if (!status) {
    await interaction.editReply("No status provided.");
    return;
  }

  const itemsPerPage = 1;
  let currentPage = 0;

  let totalRequests = await jellyseerrClient.getRequestCount(status);

  const { message, requestId } = await fetchAndDisplayItems(
    interaction,
    status,
    currentPage,
    itemsPerPage,
    totalRequests
  );

  setupMessageCollector(
    message,
    interaction,
    status,
    currentPage,
    itemsPerPage,
    totalRequests,
    requestId
  );
}

async function fetchAndDisplayItems(
  interaction: ChatInputCommandInteraction,
  status: RequestStatus,
  page: number,
  itemsPerPage: number,
  totalRequests: number
) {
  const requests = await jellyseerrClient.getRequests(
    itemsPerPage,
    page * itemsPerPage,
    status
  );

  if (requests.results.length === 0) {
    return {
      message: await interaction.editReply(createErrorEmbed(status)),
      requestId: undefined,
    };
  }

  const request = requests.results[0];
  const embed = await createRequestEmbed(
    interaction,
    status,
    request,
    page,
    itemsPerPage,
    totalRequests
  );
  const row = createActionRow(
    interaction,
    status,
    page,
    itemsPerPage,
    totalRequests
  );

  const message = await interaction.editReply({
    embeds: [embed],
    components: [row],
  });
  return { message, requestId: request.id };
}

function createErrorEmbed(status: RequestStatus) {
  const errorEmbed = new EmbedBuilder()
    .setColor(Colors.WARNING)
    .setTitle(`${status.charAt(0).toUpperCase() + status.slice(1)} Requests`)
    .setDescription("No requests to display");

  return { embeds: [errorEmbed], components: [] };
}

async function createRequestEmbed(
  interaction: ChatInputCommandInteraction,
  status: RequestStatus,
  request: any,
  page: number,
  itemsPerPage: number,
  totalRequests: number
) {
  const embed = new EmbedBuilder()
    .setColor(getColorForStatus(status))
    .setTitle(`${status.charAt(0).toUpperCase() + status.slice(1)} Requests`)
    .setFooter({
      text: `Page ${page + 1}/${Math.ceil(
        totalRequests / itemsPerPage
      )} • Total requests: ${totalRequests}`,
      iconURL: interaction.user.displayAvatarURL(),
    });

  const mediaDetails = await getMediaDetails(request);
  const mediaTitle = getMediaTitle(mediaDetails);
  const mediaType = getMediaType(request);
  const requestedBy = request.requestedBy.displayName;
  const requestStatus = getStatusString(request.status);

  addFieldsToEmbed(
    embed,
    mediaTitle,
    mediaType,
    requestedBy,
    requestStatus,
    request,
    status
  );

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

  return embed;
}

async function getMediaDetails(request: any) {
  if (request.media.mediaType === "movie") {
    return await jellyseerrClient.getMovieDetails(request.media.tmdbId);
  } else {
    return await jellyseerrClient.getTvDetails(request.media.tmdbId);
  }
}

function getMediaTitle(mediaDetails: any) {
  return mediaDetails
    ? "title" in mediaDetails
      ? mediaDetails.title
      : mediaDetails.name
    : "Unknown Title";
}

function getMediaType(request: any) {
  const type = request.media.mediaType === "movie" ? "Movie" : "Show";
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function addFieldsToEmbed(
  embed: EmbedBuilder,
  mediaTitle: string,
  mediaType: string,
  requestedBy: string,
  requestStatus: string,
  request: any,
  status: RequestStatus
) {
  embed.addFields(
    { name: "Title", value: mediaTitle, inline: true },
    { name: "Type", value: mediaType, inline: true },
    { name: "Requested by", value: requestedBy, inline: true }
  );

  if (status === "all") {
    embed.addFields({
      name: "Status",
      value: requestStatus,
      inline: true,
    });
  }

  embed.addFields(
    {
      name: "Created At",
      value: new Date(request.createdAt).toLocaleDateString("en-GB"),
      inline: true,
    },
    {
      name: "Updated At",
      value: new Date(request.updatedAt).toLocaleString("en-GB"),
      inline: true,
    }
  );
}

function createActionRow(
  interaction: ChatInputCommandInteraction,
  status: RequestStatus,
  page: number,
  itemsPerPage: number,
  totalRequests: number
) {
  const hasManagerPermissions = interaction.memberPermissions?.has(
    PermissionFlagsBits.ManageGuild
  );

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
      .setDisabled(page >= Math.ceil(totalRequests / itemsPerPage) - 1)
  );

  if (status === "pending" && hasManagerPermissions) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId("accept")
        .setLabel("Accept")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("decline")
        .setLabel("Decline")
        .setStyle(ButtonStyle.Danger)
    );
  }

  return row;
}

function setupMessageCollector(
  message: any,
  interaction: ChatInputCommandInteraction,
  status: RequestStatus,
  currentPage: number,
  itemsPerPage: number,
  totalRequests: number,
  initialRequestId: number | undefined
) {
  const collector = message.createMessageComponentCollector({ time: 60000 });
  let requestId = initialRequestId;

  collector.on("collect", async (i: any) => {
    const result = await handleCollectorInteraction(
      i,
      interaction,
      status,
      currentPage,
      itemsPerPage,
      totalRequests,
      requestId
    );
    currentPage = result.currentPage;
    requestId = result.requestId;
    totalRequests = result.totalRequests;
    collector.resetTimer();
  });

  collector.on("end", () => {
    interaction.editReply({ components: [] });
  });
}

async function handleCollectorInteraction(
  i: any,
  interaction: ChatInputCommandInteraction,
  status: RequestStatus,
  currentPage: number,
  itemsPerPage: number,
  totalRequests: number,
  requestId: number | undefined
) {
  let actionTaken = false;

  switch (i.customId) {
    case "previous":
      currentPage = Math.max(0, currentPage - 1);
      break;
    case "next":
      currentPage = Math.min(
        Math.ceil(totalRequests / itemsPerPage) - 1,
        currentPage + 1
      );
      break;
    case "accept":
      if (
        i.memberPermissions?.has(PermissionFlagsBits.ManageGuild) &&
        requestId
      ) {
        await jellyseerrClient.approveRequest(requestId);
        actionTaken = true;
      }
      break;
    case "decline":
      if (
        i.memberPermissions?.has(PermissionFlagsBits.ManageGuild) &&
        requestId
      ) {
        await jellyseerrClient.declineRequest(requestId);
        actionTaken = true;
      }
      break;
  }

  if (actionTaken) {
    totalRequests = await jellyseerrClient.getRequestCount(status);
    currentPage = Math.min(
      currentPage,
      Math.max(0, Math.ceil(totalRequests / itemsPerPage) - 1)
    );
  }

  const { message, requestId: newRequestId } = await fetchAndDisplayItems(
    interaction,
    status,
    currentPage,
    itemsPerPage,
    totalRequests
  );

  await i.update(message);

  return { currentPage, requestId: newRequestId, totalRequests };
}

function getStatusString(status: number): string {
  switch (status) {
    case 1:
      return "Pending";
    case 2:
      return "Approved";
    case 3:
      return "Declined";
    default:
      return status.toString();
  }
}

function getColorForStatus(status: string): number {
  switch (status) {
    case "available":
      return Colors.JELLYSEERR.AVAILABLE;
    case "unavailable":
      return Colors.JELLYSEERR.UNAVAILABLE;
    case "approved":
      return Colors.JELLYSEERR.APPROVED;
    case "pending":
      return Colors.JELLYSEERR.PENDING;
    case "processing":
      return Colors.JELLYSEERR.PROCESSING;
    case "failed":
      return Colors.JELLYSEERR.FAILED;
    case "declined":
      return Colors.JELLYSEERR.DECLINED;
    default:
      return Colors.JELLYSEERR.DEFAULT;
  }
}