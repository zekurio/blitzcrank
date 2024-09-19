import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Message,
  PermissionFlagsBits,
} from "discord.js";
import { jellyseerrClient } from "../../../../clients/jellyseerr/jellyseerr";
import { Colors } from "../../../../static";
import type {
  MovieDetails,
  Request,
  RequestStatus,
  TvDetails,
} from "../../../../clients/jellyseerr/models";
import { getLocalization } from "../../../../localization/localization";

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const status = interaction.options.getString("status") as RequestStatus;
  if (!status) {
    await interaction.editReply(
      getLocalization(
        "jellyseerr.requests.list.command.embeds.reply.noStatus",
        interaction.locale
      )
    );
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
      message: await interaction.editReply(
        createErrorEmbed(status, interaction.locale)
      ),
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

function createErrorEmbed(status: RequestStatus, locale: string) {
  const errorEmbed = new EmbedBuilder()
    .setColor(Colors.WARNING)
    .setTitle(
      getLocalization(
        `jellyseerr.requests.list.command.embeds.reply.title`,
        locale,
        { status: status.charAt(0).toUpperCase() + status.slice(1) }
      )
    )
    .setDescription(
      getLocalization(
        "jellyseerr.requests.list.command.embeds.reply.noRequests.description",
        locale
      )
    );

  return { embeds: [errorEmbed], components: [] };
}

async function createRequestEmbed(
  interaction: ChatInputCommandInteraction,
  status: RequestStatus,
  request: Request,
  page: number,
  itemsPerPage: number,
  totalRequests: number
) {
  const locale = interaction.locale;
  const embed = new EmbedBuilder()
    .setColor(getColorForStatus(status))
    .setTitle(
      getLocalization(
        `jellyseerr.requests.list.command.embeds.reply.title`,
        locale,
        { status: status.charAt(0).toUpperCase() + status.slice(1) }
      )
    )
    .setFooter({
      text: getLocalization(
        "jellyseerr.requests.list.command.embeds.reply.footer",
        locale,
        {
          currentPage: (page + 1).toString(),
          totalPages: Math.ceil(totalRequests / itemsPerPage).toString(),
          totalRequests: totalRequests.toString(),
        }
      ),
      iconURL: interaction.user.displayAvatarURL(),
    });

  const mediaDetails: TvDetails | MovieDetails = await getMediaDetails(request);
  const mediaTitle = getMediaTitle(mediaDetails);
  const mediaType = getMediaType(request);
  const requestedBy = request.requestedBy.displayName;
  const requestStatus = getStatusString(request.status, locale);

  addFieldsToEmbed(
    embed,
    mediaTitle,
    mediaType,
    requestedBy,
    requestStatus,
    request,
    status,
    locale
  );

  if (mediaDetails && mediaDetails.overview) {
    embed.addFields({
      name: getLocalization(
        "jellyseerr.requests.list.command.embeds.reply.fields.overview",
        locale
      ),
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

async function getMediaDetails(
  request: Request
): Promise<TvDetails | MovieDetails> {
  if (request.media.mediaType === "movie") {
    const movieDetails = await jellyseerrClient.getMovieDetails(
      request.media.tmdbId
    );
    if (movieDetails === null) {
      throw new Error("Failed to fetch movie details");
    }
    return movieDetails;
  } else {
    const tvDetails = await jellyseerrClient.getTvDetails(request.media.tmdbId);
    if (tvDetails === null) {
      throw new Error("Failed to fetch TV show details");
    }
    return tvDetails;
  }
}

function getMediaTitle(mediaDetails: TvDetails | MovieDetails) {
  return mediaDetails
    ? "title" in mediaDetails
      ? mediaDetails.title
      : mediaDetails.name
    : "Unknown Title";
}

function getMediaType(request: Request) {
  const type = request.media.mediaType === "movie" ? "Movie" : "Show";
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function addFieldsToEmbed(
  embed: EmbedBuilder,
  mediaTitle: string,
  mediaType: string,
  requestedBy: string,
  requestStatus: string,
  request: Request,
  status: RequestStatus,
  locale: string
) {
  embed.addFields(
    {
      name: getLocalization(
        "jellyseerr.requests.list.command.embeds.reply.fields.mediaTitle",
        locale
      ),
      value: mediaTitle,
      inline: true,
    },
    {
      name: getLocalization(
        "jellyseerr.requests.list.command.embeds.reply.fields.mediaType",
        locale
      ),
      value: mediaType,
      inline: true,
    },
    {
      name: getLocalization(
        "jellyseerr.requests.list.command.embeds.reply.fields.requestedBy",
        locale
      ),
      value: requestedBy,
      inline: true,
    }
  );

  if (status === "all") {
    embed.addFields({
      name: getLocalization(
        "jellyseerr.requests.list.command.embeds.reply.fields.requestStatus",
        locale
      ),
      value: requestStatus,
      inline: true,
    });
  }

  embed.addFields(
    {
      name: getLocalization(
        "jellyseerr.requests.list.command.embeds.reply.fields.requestDate",
        locale
      ),
      value: new Date(request.createdAt).toLocaleDateString(locale),
      inline: true,
    },
    {
      name: getLocalization(
        "jellyseerr.requests.list.command.embeds.reply.fields.updatedAt",
        locale
      ),
      value: new Date(request.updatedAt).toLocaleString(locale),
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
  const locale = interaction.locale ?? "en";
  const hasManagerPermissions = interaction.memberPermissions?.has(
    PermissionFlagsBits.ManageGuild
  );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`previous_${interaction.id}`)
      .setLabel(
        getLocalization(
          "jellyseerr.requests.list.command.embeds.reply.components.previous",
          locale
        )
      )
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`next_${interaction.id}`)
      .setLabel(
        getLocalization(
          "jellyseerr.requests.list.command.embeds.reply.components.next",
          locale
        )
      )
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page >= Math.ceil(totalRequests / itemsPerPage) - 1)
  );

  if (status === "pending" && hasManagerPermissions) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`accept_${interaction.id}`)
        .setLabel(
          getLocalization(
            "jellyseerr.requests.list.command.embeds.reply.components.accept",
            locale
          )
        )
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`decline_${interaction.id}`)
        .setLabel(
          getLocalization(
            "jellyseerr.requests.list.command.embeds.reply.components.decline",
            locale
          )
        )
        .setStyle(ButtonStyle.Danger)
    );
  }

  return row;
}

function setupMessageCollector(
  message: Message,
  interaction: ChatInputCommandInteraction,
  status: RequestStatus,
  currentPage: number,
  itemsPerPage: number,
  totalRequests: number,
  initialRequestId: number | undefined
) {
  const collector = message.createMessageComponentCollector({ time: 60000 });
  let requestId = initialRequestId;

  collector.on("collect", async (i: ButtonInteraction) => {
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
  i: ButtonInteraction,
  interaction: ChatInputCommandInteraction,
  status: RequestStatus,
  currentPage: number,
  itemsPerPage: number,
  totalRequests: number,
  requestId: number | undefined
) {
  let actionTaken = false;

  switch (i.customId) {
    case `previous_${interaction.id}`:
      currentPage = Math.max(0, currentPage - 1);
      break;
    case `next_${interaction.id}`:
      currentPage = Math.min(
        Math.ceil(totalRequests / itemsPerPage) - 1,
        currentPage + 1
      );
      break;
    case `accept_${interaction.id}`:
      if (
        i.memberPermissions?.has(PermissionFlagsBits.ManageGuild) &&
        requestId
      ) {
        await jellyseerrClient.approveRequest(requestId);
        actionTaken = true;
      }
      break;
    case `decline_${interaction.id}`:
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

  await i.update({ embeds: message.embeds, components: message.components });

  return { currentPage, requestId: newRequestId, totalRequests };
}

function getStatusString(status: number, locale: string): string {
  switch (status) {
    case 1:
      return getLocalization(
        "jellyseerr.requests.list.command.embeds.reply.fields.status.pending",
        locale
      );
    case 2:
      return getLocalization(
        "jellyseerr.requests.list.command.embeds.reply.fields.status.approved",
        locale
      );
    case 3:
      return getLocalization(
        "jellyseerr.requests.list.command.embeds.reply.fields.status.declined",
        locale
      );

    default:
      return getLocalization(
        "jellyseerr.requests.list.command.embeds.reply.fields.status.unknown",
        locale,
        { status: status.toString() }
      );
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
