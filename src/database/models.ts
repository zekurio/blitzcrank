import { type Emoji } from "discord.js";

// ServerEmote is a model for an emote on a discord guild
export interface ServerEmote {
  guildId: string;
  sevenTvEmote: SevenTVEmote;
  discordEmoji: Emoji;
}

// 7TVEmote is a model for an emote in the database
export interface SevenTVEmote {
  id: string;
  name: string;
}
