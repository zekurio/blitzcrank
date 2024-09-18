import { SlashCommandBuilder } from "@discordjs/builders";
import { ChatInputCommandInteraction } from "discord.js";
import { execute as executeRequests } from "./requests/requests";

export const data = new SlashCommandBuilder()
  .setName("jellyseerr")
  .setDescription("Interact with Jellyseerr")
  .addSubcommandGroup((group) =>
    group
      .setName("requests")
      .setDescription("Manage Jellyseerr requests")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("list")
          .setDescription("List jellyseerr requests")
          .addStringOption((option) =>
            option
              .setName("status")
              .setDescription("Status of the requests")
              .setRequired(true)
              .addChoices(
                { name: "All", value: "all" },
                { name: "Available", value: "available" },
                { name: "Unavailable", value: "unavailable" },
                { name: "Approved", value: "approved" },
                { name: "Pending", value: "pending" },
                { name: "Processing", value: "processing" },
                { name: "Failed", value: "failed" },
                { name: "Declined", value: "declined" }
              )
          )
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const subcommandGroup = interaction.options.getSubcommandGroup();
  const subcommand = interaction.options.getSubcommand();

  switch (subcommandGroup) {
    case "requests":
      await executeRequests(interaction, subcommand);
      break;
    default:
      await interaction.reply({
        content: "Unknown subcommand group",
        ephemeral: true,
      });
  }
}
