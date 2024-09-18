import { SlashCommandBuilder } from "@discordjs/builders";
import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  version as discordVersion,
} from "discord.js";
import os from "os";
import { Colors } from "../../static";
import { jellyfinClient } from "../../clients/jellyfin/jellyfin";
import { jellyseerrClient } from "../../clients/jellyseerr/jellyseerr";
import { getLocalization } from "../../utils/localization";

export const data = new SlashCommandBuilder()
  .setName(getLocalization("status.name"))
  .setDescription(getLocalization("status.command_description"))
  .setNameLocalizations({
    de: getLocalization("status.name", "de"),
  })
  .setDescriptionLocalizations({
    de: getLocalization("status.command_description", "de"),
  });

export async function execute(interaction: ChatInputCommandInteraction) {
  const client = interaction.client;
  const lang = interaction.locale;

  let isJellyfinReachable = false;
  try {
    isJellyfinReachable = await jellyfinClient.jellyfinStatus();
  } catch (error) {
    isJellyfinReachable = false;
  }

  let isJellyseerrReachable = false;
  try {
    isJellyseerrReachable = await jellyseerrClient.jellyseerrStatus();
  } catch (error) {
    isJellyseerrReachable = false;
  }

  const status = {
    [getLocalization("status.uptime", lang)]: formatUptime(client.uptime ?? 0),
    [getLocalization("status.ping", lang)]: `\`${
      client.ws.ping >= 0
        ? `${client.ws.ping}ms`
        : getLocalization("status.unknown", lang)
    }\``,
    [getLocalization("status.guilds", lang)]: `\`${client.guilds.cache.size}\``,
    [getLocalization("status.memoryUsage", lang)]: `\`${(
      process.memoryUsage().heapUsed /
      1024 /
      1024
    ).toFixed(2)} MB\``,
    [getLocalization("status.cpuUsage", lang)]: `\`${os
      .loadavg()[0]
      .toFixed(2)}%\``,
    [getLocalization("status.nodeVersion", lang)]: `\`${process.version}\``,
    [getLocalization("status.discordJsVersion", lang)]: `\`${discordVersion}\``,
    [getLocalization("status.osUptime", lang)]: formatUptime(
      os.uptime() * 1000
    ),
    [getLocalization("status.jellyfinStatus", lang)]: `${
      isJellyfinReachable ? "🟢" : "🔴"
    } \`${
      isJellyfinReachable
        ? getLocalization("status.reachable", lang)
        : getLocalization("status.unreachable", lang)
    }\``,
    [getLocalization("status.jellyseerrStatus", lang)]: `${
      isJellyseerrReachable ? "🟢" : "🔴"
    } \`${
      isJellyseerrReachable
        ? getLocalization("status.reachable", lang)
        : getLocalization("status.unreachable", lang)
    }\``,
  };

  const embed = new EmbedBuilder()
    .setColor(Colors.PRIMARY)
    .setTitle(getLocalization("status.title", lang))
    .setDescription(
      getLocalization("status.embed_description", lang, {
        username: client.user?.username ?? "Bot",
      })
    )
    .setThumbnail(client.user?.displayAvatarURL() ?? "")
    .setTimestamp()
    .setFooter({
      text: getLocalization("status.footer", lang, {
        user: interaction.user.tag,
      }),
      iconURL: interaction.user.displayAvatarURL(),
    });

  for (const [key, value] of Object.entries(status)) {
    embed.addFields({
      name: key,
      value: value,
      inline: true,
    });
  }

  await interaction.reply({ embeds: [embed] });
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  return `\`${days}d ${hours % 24}h ${minutes % 60}m ${seconds % 60}s\``;
}
