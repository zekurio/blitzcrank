import type { StarboardConfig, StarboardEntry } from "./models";

export interface DatabaseInterface {
  connect(): Promise<void>;

  // Starboard methods
  setStarboardConfig(config: StarboardConfig): Promise<void>;
  getStarboardConfig(
    guildId: string,
    channelId: string
  ): Promise<StarboardConfig | null>;
  setStarboardEntry(entry: StarboardEntry): Promise<void>;
  getStarboardEntry(messageId: string): Promise<StarboardEntry | null>;
  removeStarboardEntry(messageId: string): Promise<void>;
  getStarboardEntries(
    guildId: string,
    channelId: string
  ): Promise<StarboardEntry[]>;
}
