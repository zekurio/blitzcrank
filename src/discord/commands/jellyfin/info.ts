import { ChatInputCommandInteraction, EmbedBuilder } from "discord.js";
import { Colors } from "../../../static";
import { jellyfinClient } from "../../../clients/jellyfin/jellyfin";
import { ImageType } from "@jellyfin/sdk/lib/generated-client";
import { config } from "../../../config";
import { getDominantColor } from "../../../utils/colors";

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const itemId = interaction.options.getString("item");
  if (!itemId) {
    await interaction.editReply("No item ID provided.");
    return;
  }

  const itemDetails = await jellyfinClient.getItemDetails(itemId);

  if (!itemDetails) {
    await interaction.editReply("Item not found.");
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
    .setTitle(itemDetails.Name ?? "Unknown Title")
    .setDescription(itemDetails.Overview ?? "No overview available.")
    .setTimestamp()
    .setFooter({
      text: `Requested by ${interaction.user.tag}`,
      iconURL: interaction.user.displayAvatarURL(),
    })
    .setImage(imageUrl)
    .setURL(`${config.jellyfin.url}/web/index.html#!/details?id=${itemId}`);

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
    if (itemDetails.RecursiveItemCount) {
      embed.addFields({
        name: "Episodes",
        value: itemDetails.RecursiveItemCount.toString(),
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
}
