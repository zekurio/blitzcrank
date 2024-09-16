import logger from "../../logger";
import type { ClientWrapper } from "../client";

export const readyEventHandler = (wrapped: ClientWrapper) => {
    const client = wrapped.getClient();

    client.on("ready", async () => {
        logger.info(`Bot logged in`, {
            username: client.user?.username,
            id: client.user?.id,
        });
        
        for (const guild of client.guilds.cache.values()) {
            await wrapped.registerCommands(guild.id);
        }
    });
};
