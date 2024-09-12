CREATE TABLE IF NOT EXISTS starboard_config (
    id SERIAL,
    guild_id VARCHAR(25) NOT NULL,
    channel_id VARCHAR(25) NOT NULL DEFAULT '',
    threshold INTEGER NOT NULL DEFAULT 0,
    emoji_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS starboard_entries (
    message_id VARCHAR(25) PRIMARY KEY,
    starboard_id VARCHAR(25) NOT NULL DEFAULT '',
    guild_id VARCHAR(25) NOT NULL DEFAULT '',
    channel_id VARCHAR(25) NOT NULL DEFAULT '',
    author_id VARCHAR(25) NOT NULL DEFAULT '',
    score INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (message_id)
);
