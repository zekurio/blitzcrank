import { ChatInputCommandInteraction, type Client } from "discord.js";
import { commands } from "../commands";
import type { ClientWrapper } from "../client";

export const interactionCreateEventHandler = (wrapped: ClientWrapper) => {
    wrapped.getClient().on("interactionCreate", async (interaction) => {
        if (!interaction.isCommand()) {
          return;
        }
        const { commandName } = interaction;
        if (commands[commandName as keyof typeof commands]) {
          if (interaction instanceof ChatInputCommandInteraction) {
            commands[commandName as keyof typeof commands].execute(interaction); // TODO write command handler to do this
          }
        }
      });
};