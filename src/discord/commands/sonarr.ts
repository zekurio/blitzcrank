import { SlashCommandBuilder } from "@discordjs/builders";
import { ChatInputCommandInteraction, EmbedBuilder } from "discord.js";
import { getAllShows } from "../../arr/sonarr/sonarr";
import { EmbedColors } from "../../static";

export const data = new SlashCommandBuilder()
    .setName("sonarr")
    .setDescription("Interact with Sonarr")
    .addSubcommand(subcommand =>
        subcommand
            .setName("list")
            .setDescription("List all shows on Sonarr")
    );

export async function execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "list") {
        await listShows(interaction);
    } else {
        await interaction.reply({ content: "Invalid subcommand.", ephemeral: true });
    }
}

async function listShows(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    const shows = await getAllShows();

    if (shows.length === 0) {
        await interaction.editReply("No shows found in Sonarr.");
        return;
    }

    const embed = new EmbedBuilder()
        .setColor(EmbedColors.PRIMARY)
        .setTitle("Sonarr Shows")
        .setDescription("Here's a list of all shows in Sonarr:")
        .setTimestamp()
        .setFooter({
            text: `Requested by ${interaction.user.tag}`,
            iconURL: interaction.user.displayAvatarURL(),
        });

    shows.forEach((show, index) => {
        if (index < 25) { // Discord has a limit of 25 fields per embed
            embed.addFields({ name: show.title, value: `Status: ${show.status}`, inline: true });
        }
    });

    if (shows.length > 25) {
        embed.addFields({ name: "Note", value: `Showing 25 out of ${shows.length} shows.` });
    }

    await interaction.editReply({ embeds: [embed] });
}
