CREATE TABLE IF NOT EXISTS server_emotes (
  id SERIAL PRIMARY KEY,
  guild_id VARCHAR(255) NOT NULL,
  seventv_emote_id VARCHAR(255) NOT NULL,
  seventv_emote_name VARCHAR(255) NOT NULL,
  discord_emoji_id VARCHAR(255) NOT NULL,
  discord_emoji_name VARCHAR(255) NOT NULL,
  discord_emoji_animated BOOLEAN NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(guild_id, seventv_emote_id)
);

CREATE INDEX idx_server_emotes_guild_id ON server_emotes(guild_id); 