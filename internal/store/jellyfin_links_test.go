package store

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestJellyfinUserLinkCRUDIsGuildAndDiscordUserScoped(t *testing.T) {
	ctx := context.Background()
	state, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()

	now := time.Date(2026, time.July, 10, 10, 0, 0, 0, time.UTC)
	link := JellyfinUserLink{
		GuildID:        " guild ",
		DiscordUserID:  " discord-user ",
		JellyfinUserID: " jellyfin-user ",
		LinkedAt:       now,
	}
	if err := state.UpsertJellyfinUserLink(ctx, link); err != nil {
		t.Fatalf("UpsertJellyfinUserLink() error = %v", err)
	}
	loaded, ok, err := state.LoadJellyfinUserLink(ctx, "guild", "discord-user")
	if err != nil || !ok {
		t.Fatalf("LoadJellyfinUserLink() = %#v, %v, %v", loaded, ok, err)
	}
	if loaded.JellyfinUserID != "jellyfin-user" || !loaded.LinkedAt.Equal(now) || !loaded.UpdatedAt.Equal(now) {
		t.Fatalf("loaded = %#v", loaded)
	}
	if _, ok, err := state.LoadJellyfinUserLink(ctx, "other-guild", "discord-user"); err != nil || ok {
		t.Fatalf("LoadJellyfinUserLink(other guild) = ok %v, err %v", ok, err)
	}

	updatedAt := now.Add(time.Minute)
	if err := state.UpsertJellyfinUserLink(ctx, JellyfinUserLink{
		GuildID:        "guild",
		DiscordUserID:  "discord-user",
		JellyfinUserID: "new-jellyfin-user",
		LinkedAt:       updatedAt,
		UpdatedAt:      updatedAt,
	}); err != nil {
		t.Fatalf("UpsertJellyfinUserLink(update) error = %v", err)
	}
	loaded, ok, err = state.LoadJellyfinUserLink(ctx, "guild", "discord-user")
	if err != nil || !ok {
		t.Fatalf("LoadJellyfinUserLink() after update = %#v, %v, %v", loaded, ok, err)
	}
	if loaded.JellyfinUserID != "new-jellyfin-user" || !loaded.LinkedAt.Equal(now) || !loaded.UpdatedAt.Equal(updatedAt) {
		t.Fatalf("updated link = %#v", loaded)
	}
	if err := state.DeleteJellyfinUserLink(ctx, "other-guild", "discord-user"); err == nil {
		t.Fatal("DeleteJellyfinUserLink(other guild) error = nil")
	}
	if err := state.DeleteJellyfinUserLink(ctx, "guild", "discord-user"); err != nil {
		t.Fatalf("DeleteJellyfinUserLink() error = %v", err)
	}
	if _, ok, err := state.LoadJellyfinUserLink(ctx, "guild", "discord-user"); err != nil || ok {
		t.Fatalf("LoadJellyfinUserLink() after delete = ok %v, err %v", ok, err)
	}
}

func TestJellyfinUserLinksSchemaContainsNoCredentialColumns(t *testing.T) {
	ctx := context.Background()
	state, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()

	rows, err := state.db.QueryContext(ctx, `SELECT name FROM pragma_table_info('jellyfin_user_links')`)
	if err != nil {
		t.Fatalf("inspect jellyfin_user_links: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var column string
		if err := rows.Scan(&column); err != nil {
			t.Fatalf("scan jellyfin_user_links column: %v", err)
		}
		lower := strings.ToLower(column)
		for _, forbidden := range []string{"username", "password", "token", "secret", "api_key"} {
			if strings.Contains(lower, forbidden) {
				t.Fatalf("jellyfin_user_links unexpectedly has credential column %q", column)
			}
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("inspect jellyfin_user_links rows: %v", err)
	}
}
