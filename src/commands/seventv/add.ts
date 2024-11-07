import { EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { Colors } from "../../static";
import { seventvClient } from "../../clients/seventv/api";

export async function handleAddCommand(
  interaction: ChatInputCommandInteraction
) {
  await interaction.deferReply({ ephemeral: true });

  const url = interaction.options.getString("url");
  const emoteName = interaction.options.getString("name");

  if (!url || !emoteName) {
    throw new Error("Please provide both a URL and a name for the emote.");
  }

  const emote = await seventvClient.getEmoteFromUrl(url);
  const emoteImageBuffer = await seventvClient.downloadEmoteImage(emote.id, 2);

  await addEmote(interaction, emoteImageBuffer, emoteName);
}

async function addEmote(
  interaction: ChatInputCommandInteraction,
  image: Buffer,
  emoteName: string
) {
  const guild = interaction.guild;
  if (!guild) {
    throw new Error("Not running in a guild.");
  }

  const emoji = await guild.emojis.create({
    attachment: image,
    name: emoteName,
  });

  const successEmbed = new EmbedBuilder()
    .setColor(Colors.SUCCESS)
    .setTitle("Emote added")
    .setDescription("Emote added to the server.")
    .setThumbnail(emoji.url);

  await interaction.editReply({ embeds: [successEmbed] });
}
