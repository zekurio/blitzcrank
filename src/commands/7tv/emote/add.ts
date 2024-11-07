import { EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { getLocalization } from "../../../localization/localization";
import { Colors } from "../../../static";
import { getEmoteImage, sliceWideImage } from "../../../utils/emotes";
import type { EmoteImage, SlicedImage } from "../../../utils/emotes";

export async function handleAddEmoteCommand(
  interaction: ChatInputCommandInteraction
) {
  const lang = interaction.locale || "en";

  const url = interaction.options.getString("url");
  if (!url) {
    const errorEmbed = new EmbedBuilder()
      .setColor(Colors.WARNING)
      .setTitle(
        getLocalization("7tv.emote.add.embeds.noUrlProvided.title", lang)
      )
      .setDescription(
        getLocalization("7tv.emote.add.embeds.noUrlProvided.description", lang)
      );

    return { embeds: [errorEmbed], components: [] };
  }

  const emoteName = interaction.options.getString("name");
  if (!emoteName) {
    const errorEmbed = new EmbedBuilder()
      .setColor(Colors.WARNING)
      .setTitle(
        getLocalization("7tv.emote.add.embeds.noNameProvided.title", lang)
      )
      .setDescription(
        getLocalization("7tv.emote.add.embeds.noNameProvided.description", lang)
      );

    return { embeds: [errorEmbed], components: [] };
  }

  const imageBuffer = await getEmoteImage(url!);

  if (imageBuffer.width > 64) {
    const slicedImage = await sliceWideImage(imageBuffer.image);
    for (let i = 0; i < slicedImage.parts.length; i++) {
      const image = slicedImage.parts[i];
      addEmote(interaction, image, `${emoteName}_${i + 1}`);
    }
  } else {
    addEmote(interaction, imageBuffer, emoteName);
  }
}

async function addEmote(
  interaction: ChatInputCommandInteraction,
  image: EmoteImage,
  emoteName: string
) {
  const guild = interaction.guild;
  if (!guild) {
    const errorEmbed = new EmbedBuilder()
      .setColor(Colors.WARNING)
      .setTitle(
        getLocalization(
          "7tv.emote.add.embeds.noGuild.title",
          interaction.locale
        )
      )
      .setDescription(
        getLocalization(
          "7tv.emote.add.embeds.noGuild.description",
          interaction.locale
        )
      );

    await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
    return;
  }

  try {
    const emoji = await guild.emojis.create({
      attachment: image.image,
      name: emoteName,
    });

    const successEmbed = new EmbedBuilder()
      .setColor(Colors.SUCCESS)
      .setTitle(
        getLocalization(
          "7tv.emote.add.embeds.success.title",
          interaction.locale
        )
      )
      .setDescription(
        getLocalization(
          "7tv.emote.add.embeds.success.description",
          interaction.locale
        )
      )
      .setThumbnail(emoji.url);

    await interaction.reply({ embeds: [successEmbed], ephemeral: true });
  } catch (error) {
    const errorEmbed = new EmbedBuilder()
      .setColor(Colors.ERROR)
      .setTitle(
        getLocalization("7tv.emote.add.embeds.error.title", interaction.locale)
      )
      .setDescription(
        getLocalization(
          "7tv.emote.add.embeds.error.description",
          interaction.locale
        )
      );

    await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
  }
}
