package discord

import (
	"context"
	"fmt"
	"log"
	"strings"

	"blitzcrank/internal/tools"
)

func discordToolGroupsForContent(content string) []string {
	text := strings.ToLower(strings.TrimSpace(content))
	text = strings.NewReplacer("ä", "ae", "ö", "oe", "ü", "ue", "ß", "ss").Replace(text)
	text = strings.Join(strings.Fields(text), " ")
	var groups []string
	add := func(group string) {
		for _, existing := range groups {
			if existing == group {
				return
			}
		}
		groups = append(groups, group)
	}
	if containsCapability(text, "jellyseerr", "overseerr", "seerr", "request", "issue") {
		add("jellyseerr")
	}
	if containsCapability(text, "jellyfin", "library", "libraries", "playback", "watched", "played", "user", "users", "view", "views", "subtitle", "subtitles", "untertitel", "audio", "tonspur", "verfuegbar", "available") {
		add("jellyfin")
	}
	if containsCapability(text, "sonarr", "series", "season", "episode", "tvdb", "serie", "staffel", "folge", "s0") {
		add("sonarr")
	}
	if containsCapability(text, "radarr", "movie", "film", "tmdb") {
		add("radarr")
	}
	if containsCapability(text, "sabnzbd", "sab", "download", "queue", "blocklist", "import", "stuck", "failed", "haengt", "fehler") {
		add("sabnzbd")
	}
	if containsCapability(text, "disk", "filesystem", "file", "path", "permissions", "folder", "directory", "speicher", "datei", "ordner", "import", "completed") {
		add("filesystem")
	}
	if len(groups) == 0 {
		return []string{"jellyseerr", "jellyfin"}
	}
	return groups
}

func containsCapability(text string, needles ...string) bool {
	for _, needle := range needles {
		if strings.Contains(text, needle) {
			return true
		}
	}
	return false
}

func (b *Bot) seerrUserIDForDiscordUser(discordUserID string) string {
	discordUserID = strings.TrimSpace(discordUserID)
	if discordUserID == "" {
		return ""
	}
	if b.cfg.DiscordSeerrUserMap != nil {
		if mapped := strings.TrimSpace(b.cfg.DiscordSeerrUserMap[discordUserID]); mapped != "" {
			return mapped
		}
	}
	registry := tools.NewRegistry(b.cfg)
	mapped, err := registry.SeerrFindUserByDiscordID(context.Background(), discordUserID)
	if err != nil {
		log.Printf("resolve Seerr user by Discord id failed: discord=%s error=%v", discordUserID, err)
		return ""
	}
	return strings.TrimSpace(mapped)
}

func (b *Bot) seerrRequestContext(content, requesterDiscordID string) (string, string) {
	var lines []string
	requesterDiscordID = strings.TrimSpace(requesterDiscordID)
	requesterSeerrID := b.seerrUserIDForDiscordUser(requesterDiscordID)
	if requesterDiscordID != "" {
		if requesterSeerrID != "" {
			lines = append(lines, fmt.Sprintf("- Discord requester `<@%s>` maps to Seerr user id `%s`.", requesterDiscordID, requesterSeerrID))
		} else {
			lines = append(lines, fmt.Sprintf("- Discord requester `<@%s>` has no configured Seerr user mapping.", requesterDiscordID))
		}
	}
	for _, mentionedID := range mentionedDiscordUserIDs(content) {
		seerrID := b.seerrUserIDForDiscordUser(mentionedID)
		if seerrID == "" {
			continue
		}
		lines = append(lines, fmt.Sprintf("- Mentioned Discord user `<@%s>` maps to Seerr user id `%s`.", mentionedID, seerrID))
	}
	if len(lines) == 0 {
		return requesterSeerrID, ""
	}
	lines = append(lines, "- For new acquisition requests, prefer Seerr request tools over direct Sonarr/Radarr add/monitor actions.")
	return requesterSeerrID, strings.Join(uniqueStringValues(lines), "\n")
}

func mentionedDiscordUserIDs(content string) []string {
	var ids []string
	for _, field := range strings.Fields(content) {
		value := strings.Trim(field, ",.;:!?()[]{}")
		value = strings.TrimPrefix(value, "<@!")
		value = strings.TrimPrefix(value, "<@")
		value = strings.TrimSuffix(value, ">")
		if value == field || value == "" {
			continue
		}
		valid := true
		for _, r := range value {
			if r < '0' || r > '9' {
				valid = false
				break
			}
		}
		if valid {
			ids = append(ids, value)
		}
	}
	return uniqueStringValues(ids)
}

func uniqueStringValues(values []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}
