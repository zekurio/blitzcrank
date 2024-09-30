import { ButtonInteraction } from "discord.js";
import { buttonHandler } from "../../utils/buttonhandler";

export async function handleButtonInteraction(interaction: ButtonInteraction) {
  await buttonHandler.handleButton(interaction);
}
