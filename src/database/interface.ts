import type { ServerEmote } from "./models";

export interface DatabaseInterface {
  connect(): Promise<void>;
  getServerEmotes(guildId: string): Promise<ServerEmote[]>;
  addUpdateServerEmote(emote: ServerEmote): Promise<void>;
}
