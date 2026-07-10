package arrcalendar

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"blitzcrank/internal/digest"
)

func TestFetchCombinesMonitoredCalendars(t *testing.T) {
	start := time.Date(2026, 7, 13, 0, 0, 0, 0, time.UTC)
	end := start.AddDate(0, 0, 7)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-Api-Key") != "secret" || request.URL.Path != "/api/v3/calendar" {
			t.Errorf("request = %s, key %q", request.URL.Path, request.Header.Get("X-Api-Key"))
		}
		if request.URL.Query().Get("unmonitored") != "false" || request.URL.Query().Get("start") == "" || request.URL.Query().Get("end") == "" {
			t.Errorf("query = %v", request.URL.Query())
		}
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Query().Get("includeSeries") {
		case "true":
			_, _ = response.Write([]byte(`[{"id":1,"tvdbId":11,"seasonNumber":2,"episodeNumber":3,"title":"Return","overview":"Episode","airDateUtc":"2026-07-14T18:00:00Z","hasFile":false,"monitored":true,"series":{"title":"Example Show","monitored":true,"tvdbId":99}},{"id":2,"airDateUtc":"2026-07-15T18:00:00Z","monitored":false,"series":{"title":"Ignored","monitored":true}}]`))
		default:
			_, _ = response.Write([]byte(`[{"id":4,"tmdbId":44,"title":"Example Movie","overview":"Movie","monitored":true,"hasFile":true,"inCinemas":"2026-07-15T00:00:00Z","digitalRelease":"2026-07-18T00:00:00Z"},{"id":5,"title":"Ignored","monitored":false,"inCinemas":"2026-07-16T00:00:00Z"}]`))
		}
	}))
	defer server.Close()

	client, err := New(server.URL, "secret", server.URL, "secret", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.Fetch(context.Background(), digest.CalendarQuery{Topics: []digest.Topic{digest.TopicShows, digest.TopicMovies}, Start: start, End: end, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 3 || result.Items[0].Source != "Sonarr" || result.Items[1].Kind != digest.EntryKindCinema || result.Items[2].Kind != digest.EntryKindDigital {
		t.Fatalf("items = %#v", result.Items)
	}
	if result.Items[0].EventKey != "sonarr:episode:11:2026-07-14T18:00:00Z" || result.Items[1].EventKey != "radarr:movie:44:cinema:2026-07-15T00:00:00Z" {
		t.Fatalf("event keys = %q, %q", result.Items[0].EventKey, result.Items[1].EventKey)
	}
}

func TestFetchReturnsPartialCalendar(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Query().Get("includeSeries") == "true" {
			http.Error(response, "offline", http.StatusBadGateway)
			return
		}
		_, _ = response.Write([]byte(`[]`))
	}))
	defer server.Close()
	client, _ := New(server.URL, "secret", server.URL, "secret", server.Client())
	start := time.Now().UTC()
	result, err := client.Fetch(context.Background(), digest.CalendarQuery{Topics: []digest.Topic{digest.TopicShows, digest.TopicMovies}, Start: start, End: start.Add(time.Hour)})
	if err != nil || len(result.Warnings) != 1 || result.Warnings[0] != "Sonarr calendar unavailable" {
		t.Fatalf("result = %#v, error = %v", result, err)
	}
}
