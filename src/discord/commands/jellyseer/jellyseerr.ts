import { SlashCommandBuilder } from "@discordjs/builders";
import { ChatInputCommandInteraction } from "discord.js";
import { execute as executeRequests } from "./requests/requests";
import { getLocalization } from "../../../localization/localization";

export const data = new SlashCommandBuilder()
  .setName(getLocalization("jellyseerr.command.name"))
  .setNameLocalization("de", getLocalization("jellyseerr.command.name", "de"))
  .setDescription(getLocalization("jellyseerr.command.description"))
  .setDescriptionLocalization(
    "de",
    getLocalization("jellyseerr.command.description", "de")
  )
  .addSubcommandGroup((group) =>
    group
      .setName(getLocalization("jellyseerr.requests.command.name"))
      .setNameLocalization(
        "de",
        getLocalization("jellyseerr.requests.command.name", "de")
      )
      .setDescription(
        getLocalization("jellyseerr.requests.command.description")
      )
      .setDescriptionLocalization(
        "de",
        getLocalization("jellyseerr.requests.command.description", "de")
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName(getLocalization("jellyseerr.requests.list.command.name"))
          .setNameLocalization(
            "de",
            getLocalization("jellyseerr.requests.list.command.name", "de")
          )
          .setDescription(
            getLocalization("jellyseerr.requests.list.command.description")
          )
          .setDescriptionLocalization(
            "de",
            getLocalization(
              "jellyseerr.requests.list.command.description",
              "de"
            )
          )
          .addStringOption((option) =>
            option
              .setName(
                getLocalization(
                  "jellyseerr.requests.list.command.options.status.name"
                )
              )
              .setDescription(
                getLocalization(
                  "jellyseerr.requests.list.command.options.status.description"
                )
              )
              .setNameLocalization(
                "de",
                getLocalization(
                  "jellyseerr.requests.list.command.options.status.name",
                  "de"
                )
              )
              .setDescriptionLocalization(
                "de",
                getLocalization(
                  "jellyseerr.requests.list.command.options.status.description",
                  "de"
                )
              )
              .setRequired(true)
              .addChoices(
                {
                  name: getLocalization(
                    "jellyseerr.requests.list.command.options.status.choices.all"
                  ),
                  value: "all",
                  name_localizations: {
                    de: getLocalization(
                      "jellyseerr.requests.list.command.options.status.choices.all",
                      "de"
                    ),
                  },
                },
                {
                  name: getLocalization(
                    "jellyseerr.requests.list.command.options.status.choices.available"
                  ),
                  value: "available",
                  name_localizations: {
                    de: getLocalization(
                      "jellyseerr.requests.list.command.options.status.choices.available",
                      "de"
                    ),
                  },
                },
                {
                  name: getLocalization(
                    "jellyseerr.requests.list.command.options.status.choices.unavailable"
                  ),
                  value: "unavailable",
                  name_localizations: {
                    de: getLocalization(
                      "jellyseerr.requests.list.command.options.status.choices.unavailable",
                      "de"
                    ),
                  },
                },
                {
                  name: getLocalization(
                    "jellyseerr.requests.list.command.options.status.choices.approved"
                  ),
                  value: "approved",
                  name_localizations: {
                    de: getLocalization(
                      "jellyseerr.requests.list.command.options.status.choices.approved",
                      "de"
                    ),
                  },
                },
                {
                  name: getLocalization(
                    "jellyseerr.requests.list.command.options.status.choices.pending"
                  ),
                  value: "pending",
                  name_localizations: {
                    de: getLocalization(
                      "jellyseerr.requests.list.command.options.status.choices.pending",
                      "de"
                    ),
                  },
                },
                {
                  name: getLocalization(
                    "jellyseerr.requests.list.command.options.status.choices.processing"
                  ),
                  value: "processing",
                  name_localizations: {
                    de: getLocalization(
                      "jellyseerr.requests.list.command.options.status.choices.processing",
                      "de"
                    ),
                  },
                },
                {
                  name: getLocalization(
                    "jellyseerr.requests.list.command.options.status.choices.failed"
                  ),
                  value: "failed",
                  name_localizations: {
                    de: getLocalization(
                      "jellyseerr.requests.list.command.options.status.choices.failed",
                      "de"
                    ),
                  },
                },
                {
                  name: getLocalization(
                    "jellyseerr.requests.list.command.options.status.choices.declined"
                  ),
                  value: "declined",
                  name_localizations: {
                    de: getLocalization(
                      "jellyseerr.requests.list.command.options.status.choices.declined",
                      "de"
                    ),
                  },
                }
              )
          )
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const subcommandGroup = interaction.options.getSubcommandGroup();

  if (subcommandGroup === "requests") {
    await executeRequests(interaction);
  } else {
    throw new Error(`Unknown subcommand group: ${subcommandGroup}`);
  }
}
