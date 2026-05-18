package discord

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestGenerateReleaseCalendarMockImages(t *testing.T) {
	if os.Getenv("GENERATE_RELEASE_CALENDAR_IMAGES") != "1" {
		t.Skip("set GENERATE_RELEASE_CALENDAR_IMAGES=1 to generate release calendar images")
	}

	location := time.FixedZone("CEST", 2*60*60)
	outputDir := filepath.Join("..", "..", "tmp", "release-calendar")
	if err := os.MkdirAll(outputDir, 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}

	items := []releaseCalendarItem{
		{Service: "Sonarr", Date: time.Date(2026, 5, 18, 18, 0, 0, 0, location), Title: "Andor S02E09 - Welcome to the Rebellion", Color: sonarrReleaseColor},
		{Service: "Radarr", Date: time.Date(2026, 5, 18, 0, 0, 0, 0, location), Title: "The Quiet Orbit (2026) - Digital", Color: radarrReleaseColor},
		{Service: "Sonarr", Date: time.Date(2026, 5, 19, 21, 15, 0, 0, location), Title: "Severance S03E04 - Cold Storage", Color: sonarrReleaseColor},
		{Service: "Radarr", Date: time.Date(2026, 5, 20, 0, 0, 0, 0, location), Title: "Midnight Archive (2026) - Cinemas", Color: radarrReleaseColor},
		{Service: "Sonarr", Date: time.Date(2026, 5, 21, 19, 45, 0, 0, location), Title: "Foundation S04E02 - The Mathematician's Door", Color: sonarrReleaseColor},
		{Service: "Radarr", Date: time.Date(2026, 5, 21, 0, 0, 0, 0, location), Title: "Signal Lost (2026) - Physical", Color: radarrReleaseColor},
		{Service: "Sonarr", Date: time.Date(2026, 5, 22, 17, 30, 0, 0, location), Title: "Taskmaster S20E07 - Tiny Problems", Color: sonarrReleaseColor},
		{Service: "Radarr", Date: time.Date(2026, 6, 1, 0, 0, 0, 0, location), Title: "Summer Static (2026) - Digital", Color: radarrReleaseColor},
		{Service: "Sonarr", Date: time.Date(2026, 6, 3, 20, 0, 0, 0, location), Title: "The Expanse: Origins S01E01 - Burn Sequence", Color: sonarrReleaseColor},
		{Service: "Radarr", Date: time.Date(2026, 6, 5, 0, 0, 0, 0, location), Title: "Garden of Stars (2026) - Cinemas", Color: radarrReleaseColor},
		{Service: "Sonarr", Date: time.Date(2026, 6, 15, 21, 0, 0, 0, location), Title: "Slow Horses S06E03 - Loose Ends", Color: sonarrReleaseColor},
		{Service: "Radarr", Date: time.Date(2026, 6, 18, 0, 0, 0, 0, location), Title: "Glass Harbor (2026) - Physical", Color: radarrReleaseColor},
		{Service: "Sonarr", Date: time.Date(2026, 6, 27, 20, 30, 0, 0, location), Title: "Doctor Who S16E08 - A Map of Storms", Color: sonarrReleaseColor},
		{Service: "Radarr", Date: time.Date(2026, 6, 30, 0, 0, 0, 0, location), Title: "Last Train North (2026) - Digital", Color: radarrReleaseColor},
	}
	for i, item := range items {
		switch item.Service {
		case "Sonarr":
			items[i].Date = item.Date.Add(45 * time.Minute)
		case "Radarr":
			items[i].Date = item.Date.Add(2 * time.Hour)
		}
	}

	cases := []struct {
		filename string
		start    time.Time
		end      time.Time
		label    string
	}{
		{
			filename: "release-calendar-day.png",
			start:    time.Date(2026, 5, 18, 0, 0, 0, 0, location),
			end:      time.Date(2026, 5, 19, 0, 0, 0, 0, location),
			label:    "heute (2026-05-18)",
		},
		{
			filename: "release-calendar-week.png",
			start:    time.Date(2026, 5, 18, 0, 0, 0, 0, location),
			end:      time.Date(2026, 5, 25, 0, 0, 0, 0, location),
			label:    "diese Woche (2026-05-18 bis 2026-05-24)",
		},
		{
			filename: "release-calendar-month-empty-week.png",
			start:    time.Date(2026, 6, 1, 0, 0, 0, 0, location),
			end:      time.Date(2026, 7, 1, 0, 0, 0, 0, location),
			label:    "dieser Monat (2026-06-01 bis 2026-06-30)",
		},
	}

	for _, tc := range cases {
		data, err := renderReleaseCalendarPNG(tc.start, tc.end, tc.label, items, nil)
		if err != nil {
			t.Fatalf("renderReleaseCalendarPNG(%s) error = %v", tc.filename, err)
		}
		path := filepath.Join(outputDir, tc.filename)
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatalf("WriteFile(%s) error = %v", path, err)
		}
	}
}
