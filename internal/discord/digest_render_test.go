package discord

import (
	"strings"
	"testing"
	"time"

	"blitzcrank/internal/digest"
)

func TestRenderNewsletterUsesArrAttribution(t *testing.T) {
	subscription := digest.Subscription{Locale: "en-US"}
	content := digest.Content{WindowStart: time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC), WindowEnd: time.Date(2026, 7, 8, 0, 0, 0, 0, time.UTC), Items: []digest.Entry{{Title: "Show", Subtitle: "S01E01 · Pilot", Topic: digest.TopicShows, Kind: digest.EntryKindEpisode, OccursAt: time.Date(2026, 7, 2, 0, 0, 0, 0, time.UTC), Source: "Sonarr"}}}
	_, embeds := renderDigestContent(subscription, content, false)
	if len(embeds) != 2 || !strings.Contains(embeds[0].Footer.Text, "Sonarr and Radarr") || embeds[1].Title != "Show · S01E01 · Pilot" {
		t.Fatalf("embeds = %#v", embeds)
	}
}
