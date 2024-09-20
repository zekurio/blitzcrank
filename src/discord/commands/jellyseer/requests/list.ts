import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { jellyseerrClient } from "../../../../clients/jellyseerr/jellyseerr";
import { Colors } from "../../../../static";
import type {
  MovieDetails,
  Request,
  RequestStatus,
  RequestsResponse,
  TvDetails,
} from "../../../../clients/jellyseerr/models";
import { getLocalization } from "../../../../localization/localization";
import { Paginator, type PaginatorPage } from "../../../../utils/paginator";
import logger from "../../../../logger";

export async function handleListCommand(
  interaction: ChatInputCommandInteraction
) {
  await interaction.deferReply({ ephemeral: true });

  const locale = interaction.locale || "en";
  let status = interaction.options.getString("status") as RequestStatus | null;
  if (!status) {
    status = "all" as RequestStatus;
  }

  let totalRequests = await jellyseerrClient.getRequestCount(status);
  if (totalRequests === 0) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.WARNING)
          .setTitle(
            getLocalization(
              "jellyseerr.requests.list.command.embeds.reply.noRequests.title",
              interaction.locale
            )
          ),
      ],
    });
    return;
  }

  const response = await jellyseerrClient.getRequests(totalRequests, 0, status);
  const requests = response.results;

  const pages: PaginatorPage[] = [];

  for (let i = 0; i < requests.length; i++) {
    const request = requests[i];
    const mediaDetails: TvDetails | MovieDetails = await getMediaDetails(
      request
    );
    const mediaTitle = getMediaTitle(mediaDetails);
    const mediaType = getMediaType(request);
    const requestedBy = request.requestedBy.displayName;
    const requestStatus = getStatusString(request.status, locale);

    const embed = new EmbedBuilder()
      .setColor(getColorForStatus(status))
      .setTitle(mediaTitle)
      .setAuthor({
        name: getLocalization(
          `jellyseerr.requests.list.command.embeds.reply.author`,
          locale
        ),
      })
      .addFields(
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
      )
      .addFields({
        name: getLocalization(
          "jellyseerr.requests.list.command.embeds.reply.fields.requestStatus",
          locale
        ),
        value: requestStatus,
        inline: true,
      })
      .addFields(
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

    let components = [];
    if (request.status === 1) {
      const acceptButton = new ButtonBuilder()
        .setCustomId(`accept_${request.id}`)
        .setLabel(
          getLocalization("components.buttons.jellyseerr.accept", locale)
        )
        .setStyle(ButtonStyle.Success);
      const declineButton = new ButtonBuilder()
        .setCustomId(`decline_${request.id}`)
        .setLabel(
          getLocalization("components.buttons.jellyseerr.decline", locale)
        )
        .setStyle(ButtonStyle.Danger);

      components.push(acceptButton, declineButton);
    }

    pages.push({
      embed: embed,
      components: components,
    });
  }

  const paginator = new Paginator(interaction, pages, totalRequests);
  await paginator.start();
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
