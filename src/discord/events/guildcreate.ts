import type { ClientWrapper } from "../client";

export const guildCreateEventHandler = (wrapped: ClientWrapper) => {
  wrapped.getClient().on("guildCreate", async (guild) => {});
};
