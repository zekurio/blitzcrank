import { EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { getLocalization } from "../../../localization/localization";
import { Colors } from "../../../static";
import { getEmoteImage, sliceWideImage } from "../../../utils/emotes";
import type { EmoteImage, SlicedImage } from "../../../utils/emotes";

export async function handleAddEmoteCommand(
  interaction: ChatInputCommandInteraction
) {
  await interaction.deferReply({ ephemeral: true });

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

    return interaction.editReply({ embeds: [errorEmbed], components: [] });
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

    return interaction.editReply({ embeds: [errorEmbed], components: [] });
  }

  try {
    const imageBuffer = await getEmoteImage(url);

    if (imageBuffer.width > 64) {
      const slicedImage = await sliceWideImage(imageBuffer.image);
      for (let i = 0; i < slicedImage.parts.length; i++) {
        const image = slicedImage.parts[i];
        await addEmote(interaction, image, `${emoteName}_${i + 1}`);
      }
    } else {
      await addEmote(interaction, imageBuffer, emoteName);
    }
  } catch (error) {
    console.error("Error processing emote:", error);
    const errorEmbed = new EmbedBuilder()
      .setColor(Colors.ERROR)
      .setTitle(getLocalization("7tv.emote.add.embeds.error.title", lang))
      .setDescription(
        getLocalization("7tv.emote.add.embeds.error.description", lang)
      );

    await interaction.editReply({ embeds: [errorEmbed] });
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

    return interaction.editReply({ embeds: [errorEmbed] });
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

    await interaction.editReply({ embeds: [successEmbed] });
  } catch (error) {
    console.error("Error creating emoji:", error);
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

    await interaction.editReply({ embeds: [errorEmbed] });
  }
}
