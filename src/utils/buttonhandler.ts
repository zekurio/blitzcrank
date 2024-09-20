import type { ButtonInteraction } from "discord.js";
import { handleAccept, handleDecline } from "../webhook/buttons";
import logger from "../logger";

export interface ButtonHandlerFunction {
  (interaction: ButtonInteraction, ...args: any[]): Promise<void>;
}

export class ButtonHandler {
  private buttonHandlerMap: Map<string, ButtonHandlerFunction>;

  constructor() {
    this.buttonHandlerMap = new Map();
  }

  public registerButtonHandler(
    buttonAction: string,
    handler: ButtonHandlerFunction
  ) {
    this.buttonHandlerMap.set(buttonAction, handler);
  }

  public async handleButton(interaction: ButtonInteraction): Promise<void> {
    const [action, ...params] = interaction.customId.split("_");

    logger.debug(`Handling button interaction: ${action}`, {
      customId: interaction.customId,
      params,
    });

    if (action.startsWith("paginator_")) {
      return;
    }

    const handler = this.buttonHandlerMap.get(action);

    if (handler) {
      await handler(interaction, ...params);
    } else {
      logger.warn(`No handler registered for button action: ${action}`);
    }
  }
}

export const buttonHandler = new ButtonHandler();

buttonHandler.registerButtonHandler("accept", handleAccept);
buttonHandler.registerButtonHandler("decline", handleDecline);
