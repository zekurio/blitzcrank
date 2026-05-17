package discord

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"testing"
	"time"

	"blitzcrank/internal/config"
)

func TestReleaseCalendarSpanUsesCalendarBoundaries(t *testing.T) {
	now := time.Date(2026, 5, 17, 15, 30, 0, 0, time.FixedZone("CEST", 2*60*60))

	tests := []struct {
		name      string
		span      string
		wantStart string
		wantEnd   string
	}{
		{name: "today german", span: "heute", wantStart: "2026-05-17", wantEnd: "2026-05-18"},
		{name: "current week german", span: "woche", wantStart: "2026-05-11", wantEnd: "2026-05-18"},
		{name: "current month german", span: "monat", wantStart: "2026-05-01", wantEnd: "2026-06-01"},
		{name: "default current week", span: "", wantStart: "2026-05-11", wantEnd: "2026-05-18"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			start, end, _, err := releaseCalendarSpan(tt.span, now)
			if err != nil {
				t.Fatalf("releaseCalendarSpan() error = %v", err)
			}
			if got := start.Format("2006-01-02"); got != tt.wantStart {
				t.Fatalf("start = %s, want %s", got, tt.wantStart)
			}
			if got := end.Format("2006-01-02"); got != tt.wantEnd {
				t.Fatalf("end = %s, want %s", got, tt.wantEnd)
			}
		})
	}
}

func TestReleaseCalendarFetchesSonarrAndRadarr(t *testing.T) {
	var sonarrQueries, radarrQueries []url.Values
	sonarr := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v3/calendar" {
			t.Fatalf("sonarr path = %s", r.URL.Path)
		}
		sonarrQueries = append(sonarrQueries, r.URL.Query())
		writeJSON(t, w, []map[string]any{{
			"title":         "Episode title",
			"airDateUtc":    "2026-05-12T20:00:00Z",
			"seasonNumber":  1,
			"episodeNumber": 2,
			"series":        map[string]any{"title": "Series title"},
		}})
	}))
	defer sonarr.Close()
	radarr := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v3/calendar" {
			t.Fatalf("radarr path = %s", r.URL.Path)
		}
		radarrQueries = append(radarrQueries, r.URL.Query())
		writeJSON(t, w, []map[string]any{{
			"releaseDate": "2026-05-13",
			"movie":       map[string]any{"title": "Movie title", "year": 2026},
		}})
	}))
	defer radarr.Close()

	bot := &Bot{cfg: config.Config{
		SonarrBaseURL: sonarr.URL,
		SonarrAPIKey:  "sonarr-key",
		RadarrBaseURL: radarr.URL,
		RadarrAPIKey:  "radarr-key",
	}}
	start := time.Date(2026, 5, 11, 0, 0, 0, 0, time.UTC)
	end := time.Date(2026, 5, 18, 0, 0, 0, 0, time.UTC)

	items, warnings, err := bot.fetchReleaseCalendarItems(context.Background(), start, end)
	if err != nil {
		t.Fatalf("fetchReleaseCalendarItems() error = %v", err)
	}
	if len(warnings) != 0 {
		t.Fatalf("warnings = %#v, want none", warnings)
	}
	if len(sonarrQueries) != 1 || len(radarrQueries) != 1 {
		t.Fatalf("query counts sonarr=%d radarr=%d, want 1/1", len(sonarrQueries), len(radarrQueries))
	}
	for _, query := range []url.Values{sonarrQueries[0], radarrQueries[0]} {
		if query.Get("start") != "2026-05-11" || query.Get("end") != "2026-05-18" || query.Get("unmonitored") != "false" {
			t.Fatalf("calendar query = %v", query)
		}
	}
	if sonarrQueries[0].Get("includeSeries") != "true" {
		t.Fatalf("sonarr query = %v, want includeSeries", sonarrQueries[0])
	}
	if radarrQueries[0].Get("includeMovie") != "true" {
		t.Fatalf("radarr query = %v, want includeMovie", radarrQueries[0])
	}

	var titles []string
	for _, item := range items {
		titles = append(titles, item.Title)
	}
	if !slices.Contains(titles, "Series title S01E02 - Episode title") || !slices.Contains(titles, "Movie title (2026)") {
		t.Fatalf("titles = %#v", titles)
	}
}

func writeJSON(t *testing.T, w http.ResponseWriter, value any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Fatalf("Encode() error = %v", err)
	}
}
