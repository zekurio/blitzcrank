import { SlashCommandBuilder } from "@discordjs/builders";
import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  version as discordVersion,
} from "discord.js";
import os from "os";
import { Colors } from "../../static";
import { jellyfinStatus } from "../../clients/jellyfin";

export const data = new SlashCommandBuilder()
  .setName("status")
  .setDescription("Get status for Blitzcrank and services tied to it");

export async function execute(interaction: ChatInputCommandInteraction) {
  const client = interaction.client;

  let isJellyfinReachable = false;
  try {
    isJellyfinReachable = await jellyfinStatus();
  } catch (error) {
    isJellyfinReachable = false;
  }
  const jellyfinStatusDot = isJellyfinReachable ? "🟢" : "🔴";

  const status = {
    Uptime: formatUptime(client.uptime ?? 0),
    Ping: `\`${
      client.ws.ping >= 0 ? `${client.ws.ping}ms` : "I don't fucking know"
    }\``,
    Guilds: `\`${client.guilds.cache.size}\``,
    "Memory Usage": `\`${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(
      2
    )} MB\``,
    "CPU Usage": `\`${os.loadavg()[0].toFixed(2)}%\``,
    "Node Version": `\`${process.version}\``,
    "Discord.js Version": `\`${discordVersion}\``,
    "OS Uptime": formatUptime(os.uptime() * 1000),
    "Jellyfin Status": `${jellyfinStatusDot} \`${
      isJellyfinReachable ? "Reachable" : "Unreachable"
    }\``,
  };

  const embed = new EmbedBuilder()
    .setColor(Colors.PRIMARY)
    .setTitle("Bot Status")
    .setDescription(`Here's the current status of ${client.user?.username}`)
    .setThumbnail(client.user?.displayAvatarURL() ?? "")
    .setTimestamp()
    .setFooter({
      text: `Requested by ${interaction.user.tag}`,
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
