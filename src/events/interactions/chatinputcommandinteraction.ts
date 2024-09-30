import { ChatInputCommandInteraction } from "discord.js";
import { commands } from "../../commands";

export const handleChatCommand = async (
  interaction: ChatInputCommandInteraction
) => {
  const { commandName } = interaction;
  if (commands[commandName as keyof typeof commands]) {
    await commands[commandName as keyof typeof commands].execute(interaction);
  }
};
