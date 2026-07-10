package discord

import (
	"strings"
	"testing"
	"time"

	"blitzcrank/internal/digest"
	"blitzcrank/internal/recommendation"
)

func TestRenderDigestContentIsLocalizedBoundedAndURLSafe(t *testing.T) {
	subscription := digest.Subscription{
		Locale:   "de-AT",
		Timezone: "Europe/Vienna",
	}
	items := make([]recommendation.Candidate, 10)
	for index := range items {
		items[index] = recommendation.Candidate{
			MediaType:   recommendation.MediaTypeMovie,
			ReleaseKind: recommendation.ReleaseKindPhysical,
			Title:       "Film " + strings.Repeat("x", 250),
			Overview:    strings.Repeat("Beschreibung ", 100),
			URL:         "javascript:alert(1)",
			Poster:      "file:///tmp/poster.jpg",
			ReleaseAt:   time.Date(2026, time.July, 20, 0, 0, 0, 0, time.UTC),
			Source:      "tmdb",
		}
	}
	content := digest.Content{
		WindowStart: time.Date(2026, time.July, 10, 0, 0, 0, 0, time.UTC),
		WindowEnd:   time.Date(2026, time.July, 24, 0, 0, 0, 0, time.UTC),
		Items:       items,
		Partial:     true,
	}
	message, embeds := renderDigestContent(subscription, content, true)
	if message != "" || len(embeds) != 1+maxDigestItemEmbeds {
		t.Fatalf("render = message %q, embeds %d", message, len(embeds))
	}
	if embeds[0].Title != digestGerman.PreviewTitle || !strings.Contains(embeds[0].Description, digestGerman.PartialSources) || !strings.Contains(embeds[0].Description, digestGerman.MoreItems) {
		t.Fatalf("summary embed = %#v", embeds[0])
	}
	footer := embeds[0].Footer.Text
	if !strings.Contains(footer, "TMDB") || !strings.Contains(footer, "AniList") || !strings.Contains(footer, "not endorsed or certified by TMDB") {
		t.Fatalf("provider attribution footer = %q", footer)
	}
	item := embeds[1]
	if len([]rune(item.Title)) > 200 || len([]rune(item.Description)) > 360 {
		t.Fatalf("item text exceeds bounds: title=%d description=%d", len([]rune(item.Title)), len([]rune(item.Description)))
	}
	if item.URL != "" || item.Thumbnail != nil {
		t.Fatalf("unsafe URLs survived rendering: %#v", item)
	}
	if item.Fields[1].Value != digestGerman.Physical {
		t.Fatalf("release label = %q", item.Fields[1].Value)
	}
}

func TestRenderEmptyDigestStillExplainsWindow(t *testing.T) {
	subscription := digest.Subscription{Locale: "en-US", Timezone: "UTC"}
	content := digest.Content{
		WindowStart: time.Date(2026, time.July, 10, 0, 0, 0, 0, time.UTC),
		WindowEnd:   time.Date(2026, time.July, 17, 0, 0, 0, 0, time.UTC),
	}
	message, embeds := renderDigestContent(subscription, content, false)
	if message != digestEnglish.PreviewEmpty || len(embeds) != 1 {
		t.Fatalf("empty render = %q, %#v", message, embeds)
	}
	if !strings.Contains(embeds[0].Description, "2026-07-10") || !strings.Contains(embeds[0].Description, "2026-07-16") {
		t.Fatalf("window description = %q", embeds[0].Description)
	}
}

func TestRenderDigestTreatsProviderDatesAsCivilDates(t *testing.T) {
	subscription := digest.Subscription{Locale: "en-US", Timezone: "America/New_York"}
	content := digest.Content{
		WindowStart: time.Date(2026, time.July, 10, 0, 0, 0, 0, time.UTC),
		WindowEnd:   time.Date(2026, time.July, 11, 0, 0, 0, 0, time.UTC),
		Items: []recommendation.Candidate{{
			MediaType: recommendation.MediaTypeMovie, ReleaseKind: recommendation.ReleaseKindDigital,
			Title: "Civil date", ReleaseAt: time.Date(2026, time.July, 10, 0, 0, 0, 0, time.UTC), Source: "tmdb",
		}},
	}
	_, embeds := renderDigestContent(subscription, content, false)
	if len(embeds) != 2 {
		t.Fatalf("embeds = %d", len(embeds))
	}
	if got := embeds[0].Description; got != "2026-07-10 – 2026-07-10" {
		t.Fatalf("window description = %q", got)
	}
	if got := embeds[1].Fields[0].Value; got != "2026-07-10" {
		t.Fatalf("release date = %q", got)
	}
}

func TestRenderDigestSubscriptionDoesNotExposeDiscordIdentity(t *testing.T) {
	subscription := digest.Subscription{
		ID:           7,
		Subscriber:   digest.Subscriber{GuildID: "secret-guild", UserID: "secret-user"},
		Topics:       []digest.Topic{digest.TopicAnimeSeasons},
		ReleaseKinds: []digest.ReleaseKind{digest.ReleaseKindOnline},
		Cadence:      digest.CadenceWeekly,
		TimeOfDay:    "18:00",
		Region:       "AT",
		Timezone:     "Europe/Vienna",
		Locale:       "en-US",
		Enabled:      true,
	}
	embed := renderDigestSubscription(subscription, digestEnglish)
	encoded := embed.Title + embed.Description + embed.Footer.Text
	for _, field := range embed.Fields {
		encoded += field.Name + field.Value
	}
	if strings.Contains(encoded, "secret-guild") || strings.Contains(encoded, "secret-user") {
		t.Fatalf("subscription rendering exposed identity: %s", encoded)
	}
}
