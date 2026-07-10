package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// JellyfinUserLink maps a Discord account to an existing Jellyfin user ID.
// Authentication material and human-readable profile data deliberately do not
// belong in this record.
type JellyfinUserLink struct {
	GuildID        string
	DiscordUserID  string
	JellyfinUserID string
	LinkedAt       time.Time
	UpdatedAt      time.Time
}

func (s *Store) UpsertJellyfinUserLink(ctx context.Context, link JellyfinUserLink) error {
	canonical, err := canonicalJellyfinUserLink(link)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO jellyfin_user_links(guild_id,discord_user_id,jellyfin_user_id,linked_at,updated_at)
VALUES(?,?,?,?,?)
ON CONFLICT(guild_id,discord_user_id) DO UPDATE SET
  jellyfin_user_id = excluded.jellyfin_user_id,
  updated_at = excluded.updated_at
`, canonical.GuildID, canonical.DiscordUserID, canonical.JellyfinUserID, formatTime(canonical.LinkedAt), formatTime(canonical.UpdatedAt))
	return err
}

func (s *Store) LoadJellyfinUserLink(ctx context.Context, guildID, discordUserID string) (JellyfinUserLink, bool, error) {
	guildID = strings.TrimSpace(guildID)
	discordUserID = strings.TrimSpace(discordUserID)
	if guildID == "" {
		return JellyfinUserLink{}, false, errors.New("jellyfin user link guild id is required")
	}
	if discordUserID == "" {
		return JellyfinUserLink{}, false, errors.New("jellyfin user link Discord user id is required")
	}
	var link JellyfinUserLink
	err := s.db.QueryRowContext(ctx, `
SELECT guild_id,discord_user_id,jellyfin_user_id,linked_at,updated_at
FROM jellyfin_user_links
WHERE guild_id = ? AND discord_user_id = ?
`, guildID, discordUserID).Scan(&link.GuildID, &link.DiscordUserID, &link.JellyfinUserID, scanTime(&link.LinkedAt), scanTime(&link.UpdatedAt))
	if errors.Is(err, sql.ErrNoRows) {
		return JellyfinUserLink{}, false, nil
	}
	if err != nil {
		return JellyfinUserLink{}, false, err
	}
	return link, true, nil
}

func (s *Store) DeleteJellyfinUserLink(ctx context.Context, guildID, discordUserID string) error {
	guildID = strings.TrimSpace(guildID)
	discordUserID = strings.TrimSpace(discordUserID)
	if guildID == "" {
		return errors.New("jellyfin user link guild id is required")
	}
	if discordUserID == "" {
		return errors.New("jellyfin user link Discord user id is required")
	}
	result, err := s.db.ExecContext(ctx, `DELETE FROM jellyfin_user_links WHERE guild_id = ? AND discord_user_id = ?`, guildID, discordUserID)
	if err != nil {
		return err
	}
	updated, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if updated == 0 {
		return fmt.Errorf("jellyfin user link for Discord user %q does not exist", discordUserID)
	}
	return nil
}

func canonicalJellyfinUserLink(link JellyfinUserLink) (JellyfinUserLink, error) {
	link.GuildID = strings.TrimSpace(link.GuildID)
	link.DiscordUserID = strings.TrimSpace(link.DiscordUserID)
	link.JellyfinUserID = strings.TrimSpace(link.JellyfinUserID)
	if link.GuildID == "" {
		return JellyfinUserLink{}, errors.New("jellyfin user link guild id is required")
	}
	if link.DiscordUserID == "" {
		return JellyfinUserLink{}, errors.New("jellyfin user link Discord user id is required")
	}
	if link.JellyfinUserID == "" {
		return JellyfinUserLink{}, errors.New("jellyfin user id is required")
	}
	if link.LinkedAt.IsZero() {
		return JellyfinUserLink{}, errors.New("jellyfin user link linked time is required")
	}
	if link.UpdatedAt.IsZero() {
		link.UpdatedAt = link.LinkedAt
	}
	return link, nil
}
