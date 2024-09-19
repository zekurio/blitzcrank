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
  await interaction.deferReply();

  const lang = interaction.locale || "en";

  const itemId = interaction.options.getString("item");
  if (!itemId) {
    await interaction.editReply(
      getLocalization("jellyfin.about.noItemProvided", lang)
    );
    return;
  }

  const itemDetails = await jellyfinClient.getItemDetails(itemId);

  if (!itemDetails) {
    await interaction.editReply(
      getLocalization("jellyfin.about.itemNotFound", lang)
    );
    return;
  }

  let imageUrl = await jellyfinClient.getItemImageUrl(itemId, ImageType.Thumb);

  let embedColor = Colors.JELLYFIN_PURPLE;

  if (imageUrl) {
    const dominantColor = await getDominantColor(imageUrl);
    embedColor = dominantColor;
  }

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle(
      itemDetails.Name ?? getLocalization("jellyfin.about.unknownTitle", lang)
    )
    .setDescription(
      itemDetails.Overview ?? getLocalization("jellyfin.about.noOverview", lang)
    )
    .setTimestamp()
    .setFooter({
      text: getLocalization("jellyfin.about.requestedBy", lang, {
        user: interaction.user.tag,
      }),
      iconURL: interaction.user.displayAvatarURL(),
    })
    .setImage(imageUrl)
    .setURL(`${config.jellyfin.url}/web/index.html#!/details?id=${itemId}`);

  if (itemDetails.ProductionYear) {
    embed.addFields({
      name: getLocalization("jellyfin.about.year", lang),
      value: itemDetails.ProductionYear.toString(),
      inline: true,
    });
  }

  if (itemDetails.OfficialRating) {
    embed.addFields({
      name: getLocalization("jellyfin.about.rating", lang),
      value: itemDetails.OfficialRating,
      inline: true,
    });
  }

  if (itemDetails.CommunityRating) {
    embed.addFields({
      name: getLocalization("jellyfin.about.communityRating", lang),
      value: itemDetails.CommunityRating.toFixed(1),
      inline: true,
    });
  }

  if (itemDetails.Genres && itemDetails.Genres.length > 0) {
    embed.addFields({
      name: getLocalization("jellyfin.about.genres", lang),
      value: itemDetails.Genres.join(", "),
      inline: false,
    });
  }

  if (itemDetails.Studios && itemDetails.Studios.length > 0) {
    embed.addFields({
      name: getLocalization("jellyfin.about.studios", lang),
      value: itemDetails.Studios.map((studio) => studio.Name).join(", "),
      inline: false,
    });
  }

  if (itemDetails.Type === "Series") {
    embed.addFields({
      name: getLocalization("jellyfin.about.type", lang),
      value: getLocalization("jellyfin.about.tvSeries", lang),
      inline: true,
    });
    if (itemDetails.ChildCount) {
      embed.addFields({
        name: getLocalization("jellyfin.about.seasons", lang),
        value: itemDetails.ChildCount.toString(),
        inline: true,
      });
    }
    if (itemDetails.RecursiveItemCount) {
      embed.addFields({
        name: getLocalization("jellyfin.about.episodes", lang),
        value: itemDetails.RecursiveItemCount.toString(),
        inline: true,
      });
    }
  } else if (itemDetails.Type === "Movie") {
    embed.addFields({
      name: getLocalization("jellyfin.about.type", lang),
      value: getLocalization("jellyfin.about.movie", lang),
      inline: true,
    });
    if (itemDetails.RunTimeTicks) {
      const runtime = Math.floor(itemDetails.RunTimeTicks / (10000000 * 60));
      embed.addFields({
        name: getLocalization("jellyfin.about.runtime", lang),
        value: getLocalization("jellyfin.about.minutes", lang, {
          minutes: runtime.toString(),
        }),
        inline: true,
      });
    }
  }

  await interaction.editReply({ embeds: [embed] });
}
