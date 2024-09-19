import {
  CommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import { Colors } from "../../static";
import { getLocalization } from "../../localization/localization";

export const data = new SlashCommandBuilder()
  .setName("ping")
  .setNameLocalizations({
    de: getLocalization("ping.command.name", "de"),
  })
  .setDescription("Replies with Pong!")
  .setDescriptionLocalizations({
    de: getLocalization("ping.command.description", "de"),
  });

export async function execute(interaction: CommandInteraction) {
  const lang = interaction.locale || "en";

  const sent = await interaction.reply({
    content: getLocalization("ping.misc.pinging", lang),
    fetchReply: true,
    ephemeral: true,
  });
  const pingTime = sent.createdTimestamp - interaction.createdTimestamp;

  const embed = new EmbedBuilder()
    .setColor(Colors.PRIMARY)
    .setTitle(getLocalization("ping.embeds.reply.title", lang))
    .addFields(
      {
        name: getLocalization("ping.embeds.reply.fields.latency", lang),
        value: getLocalization("ping.values.latencyValue", lang, {
          pingTime: pingTime.toString(),
        }),
        inline: true,
      },
      {
        name: getLocalization("ping.embeds.reply.fields.apiLatency", lang),
        value: getLocalization("ping.values.apiLatencyValue", lang, {
          apiPing: Math.round(interaction.client.ws.ping).toString(),
        }),
        inline: true,
      }
    )
    .setTimestamp();

  await interaction.editReply({ content: null, embeds: [embed] });
}
