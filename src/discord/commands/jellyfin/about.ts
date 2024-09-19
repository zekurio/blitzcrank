import { ChatInputCommandInteraction, EmbedBuilder } from "discord.js";
import { Colors } from "../../../static";
import { jellyfinClient } from "../../../clients/jellyfin/jellyfin";
import { ImageType } from "@jellyfin/sdk/lib/generated-client";
import { config } from "../../../config";
import { getDominantColor } from "../../../utils/colors";
import { getLocalization } from "../../../localization/localization";

export async function handleAboutCommand(
  interaction: ChatInputCommandInteraction
) {
  await interaction.deferReply({ ephemeral: true });

  const lang = interaction.locale || "en";

  const itemId = interaction.options.getString("item");
  if (!itemId) {
    const errorEmbed = new EmbedBuilder()
      .setColor(Colors.WARNING)
      .setTitle(
        getLocalization("jellyfin.about.embeds.noItemProvided.title", lang)
      )
      .setDescription(
        getLocalization(
          "jellyfin.about.embeds.noItemProvided.description",
          lang
        )
      );

    return { embeds: [errorEmbed], components: [] };
  }

  const itemDetails = await jellyfinClient.getItemDetails(itemId);

  if (!itemDetails) {
    const errorEmbed = new EmbedBuilder()
      .setColor(Colors.WARNING)
      .setTitle(
        getLocalization("jellyfin.about.embeds.itemNotFound.title", lang)
      )
      .setDescription(
        getLocalization("jellyfin.about.embeds.itemNotFound.description", lang)
      );

    return { embeds: [errorEmbed], components: [] };
  }

  let imageUrl = await jellyfinClient.getItemImageUrl(itemId, ImageType.Thumb);

  let embedColor = Colors.JELLYFIN_PURPLE;

  if (imageUrl) {
    const dominantColor = await getDominantColor(imageUrl);
    embedColor = dominantColor;
  }

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setAuthor({
      name: getLocalization("jellyfin.about.embeds.reply.author", lang),
    })
    .setTitle(itemDetails.Name ?? "")
    .setDescription(
      itemDetails.Overview ??
        getLocalization("jellyfin.about.embeds.reply.noOverview", lang)
    )
    .setTimestamp()
    .setFooter({
      text: getLocalization("jellyfin.about.embeds.reply.footer", lang, {
        user: interaction.user.tag,
      }),
      iconURL: interaction.user.displayAvatarURL(),
    })
    .setImage(imageUrl)
    .setURL(`${config.jellyfin.url}/web/index.html#!/details?id=${itemId}`);

  if (itemDetails.ProductionYear) {
    embed.addFields({
      name: getLocalization("jellyfin.about.embeds.reply.fields.year", lang),
      value: itemDetails.ProductionYear.toString(),
      inline: true,
    });
  }

  if (itemDetails.OfficialRating) {
    embed.addFields({
      name: getLocalization("jellyfin.about.embeds.reply.fields.rating", lang),
      value: itemDetails.OfficialRating,
      inline: true,
    });
  }

  if (itemDetails.CommunityRating) {
    embed.addFields({
      name: getLocalization(
        "jellyfin.about.embeds.reply.fields.communityRating",
        lang
      ),
      value: itemDetails.CommunityRating.toFixed(1),
      inline: true,
    });
  }

  if (itemDetails.Genres && itemDetails.Genres.length > 0) {
    embed.addFields({
      name: getLocalization("jellyfin.about.embeds.reply.fields.genres", lang),
      value: itemDetails.Genres.join(", "),
      inline: false,
    });
  }

  if (itemDetails.Studios && itemDetails.Studios.length > 0) {
    embed.addFields({
      name: getLocalization("jellyfin.about.embeds.reply.fields.studios", lang),
      value: itemDetails.Studios.map((studio) => studio.Name).join(", "),
      inline: false,
    });
  }

  if (itemDetails.Type === "Series") {
    embed.addFields({
      name: getLocalization("jellyfin.about.embeds.reply.fields.type", lang),
      value: getLocalization(
        "jellyfin.about.embeds.reply.fields.tvSeries",
        lang
      ),
      inline: true,
    });
    if (itemDetails.ChildCount) {
      embed.addFields({
        name: getLocalization(
          "jellyfin.about.embeds.reply.fields.seasons",
          lang
        ),
        value: itemDetails.ChildCount.toString(),
        inline: true,
      });
    }
    if (itemDetails.RecursiveItemCount) {
      embed.addFields({
        name: getLocalization(
          "jellyfin.about.embeds.reply.fields.episodes",
          lang
        ),
        value: itemDetails.RecursiveItemCount.toString(),
        inline: true,
      });
    }
  } else if (itemDetails.Type === "Movie") {
    embed.addFields({
      name: getLocalization("jellyfin.about.embeds.reply.fields.type", lang),
      value: getLocalization("jellyfin.about.embeds.reply.fields.movie", lang),
      inline: true,
    });
    if (itemDetails.RunTimeTicks) {
      const runtime = Math.floor(itemDetails.RunTimeTicks / (10000000 * 60));
      embed.addFields({
        name: getLocalization(
          "jellyfin.about.embeds.reply.fields.runtime",
          lang
        ),
        value: getLocalization(
          "jellyfin.about.embeds.reply.fields.minutes",
          lang,
          {
            minutes: runtime.toString(),
          }
        ),
        inline: true,
      });
    }
  }

  await interaction.editReply({ embeds: [embed] });
}
