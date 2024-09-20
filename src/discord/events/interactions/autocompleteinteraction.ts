import type { AutocompleteInteraction } from "discord.js";
import { commands } from "../../commands";

export const handleAutocomplete = async (
  interaction: AutocompleteInteraction
) => {
  const { commandName } = interaction;
  if (commandName in commands) {
    const command = commands[commandName as keyof typeof commands];
    if (
      "autocomplete" in command &&
      typeof command.autocomplete === "function"
    ) {
      await command.autocomplete(interaction);
    }
  }
};
