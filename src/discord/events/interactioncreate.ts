import { ChatInputCommandInteraction, type Client } from "discord.js";
import { commands } from "../commands";
import type { ClientWrapper } from "../client";

export const interactionCreateEventHandler = (wrapped: ClientWrapper) => {
  wrapped.getClient().on("interactionCreate", async (interaction) => {
      if (interaction.isChatInputCommand()) {
          const { commandName } = interaction;
          if (commands[commandName as keyof typeof commands]) {
              await commands[commandName as keyof typeof commands].execute(interaction);
          }
      } else if (interaction.isAutocomplete()) {
          const { commandName } = interaction;
          if (commandName in commands) {
              const command = commands[commandName as keyof typeof commands];
              if ('autocomplete' in command && typeof command.autocomplete === 'function') {
                  await command.autocomplete(interaction);
              }
          }
      }
  });
};