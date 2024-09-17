import {
  CommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import { Colors } from "../../static";

export const data = new SlashCommandBuilder()
  .setName("ping")
  .setDescription("Replies with Pong!");

export async function execute(interaction: CommandInteraction) {
  const sent = await interaction.reply({
    content: "Pinging...",
    fetchReply: true,
  });
  const pingTime = sent.createdTimestamp - interaction.createdTimestamp;

  const embed = new EmbedBuilder()
    .setColor(Colors.PRIMARY)
    .setTitle("Pong! 🏓")
    .addFields(
      { name: "Latency", value: `${pingTime}ms`, inline: true },
      {
        name: "API Latency",
        value: `${Math.round(interaction.client.ws.ping)}ms`,
        inline: true,
      }
    )
    .setTimestamp();

  await interaction.editReply({ content: null, embeds: [embed] });
}
