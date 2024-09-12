// StarboardMessage is a message that is being starred and stored in the database
export interface StarboardEntry {
  messageId: string;
  starboardId: string;
  guildId: string;
  channelId: string;
  authorId: string;
  score: number;
}

// StarboardConfig is a configuration for a starboard in a specific guild and channel
export interface StarboardConfig {
  id: string;
  guildId: string;
  channelId: string;
  threshold: number;
  emoji: string;
  messages: StarboardEntry[];
}
