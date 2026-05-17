package discord

import (
	"testing"
	"time"
)

func TestReleaseCalendarSpanUsesCalendarBoundaries(t *testing.T) {
	location := time.FixedZone("test", 2*60*60)
	now := time.Date(2026, time.May, 17, 15, 30, 0, 0, location) // Sunday

	tests := []struct {
		name      string
		span      string
		wantStart string
		wantEnd   string
	}{
		{
			name:      "default week starts on monday",
			span:      "",
			wantStart: "2026-05-11",
			wantEnd:   "2026-05-18",
		},
		{
			name:      "explicit week starts on monday",
			span:      "week",
			wantStart: "2026-05-11",
			wantEnd:   "2026-05-18",
		},
		{
			name:      "month starts on first day",
			span:      "month",
			wantStart: "2026-05-01",
			wantEnd:   "2026-06-01",
		},
		{
			name:      "today remains one day",
			span:      "today",
			wantStart: "2026-05-17",
			wantEnd:   "2026-05-18",
		},
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

func TestRadarrCalendarItemsUsesReleaseDateAndNestedMovie(t *testing.T) {
	items := radarrCalendarItems([]any{
		map[string]any{
			"releaseDate": "2026-05-15T10:00:00Z",
			"releaseType": "digital",
			"movie": map[string]any{
				"title": "Nested Movie",
				"year":  float64(2026),
			},
		},
		map[string]any{
			"title":           "Direct Movie",
			"year":            2025,
			"physicalRelease": "2026-05-16",
		},
	})

	if len(items) != 2 {
		t.Fatalf("len(items) = %d, want 2", len(items))
	}
	if items[0].Service != "Radarr" || items[0].Title != "Nested Movie (2026)" || items[0].Date.Format(time.RFC3339) != "2026-05-15T10:00:00Z" {
		t.Fatalf("nested item = %#v", items[0])
	}
	if items[1].Title != "Direct Movie (2025)" || items[1].Date.Format("2006-01-02") != "2026-05-16" {
		t.Fatalf("direct item = %#v", items[1])
	}
}
