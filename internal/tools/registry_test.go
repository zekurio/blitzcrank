package tools

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"blitzcrank/internal/config"
)

func TestFSToolsRequireAllowedRoot(t *testing.T) {
	registry := NewRegistry(config.Config{})
	if _, err := registry.Call(context.Background(), "fs_stat_path", map[string]any{"path": "/tmp"}); err == nil {
		t.Fatal("fs_stat_path error = nil, want allowed-root error")
	}
}

func TestOpenAIToolsRequiredIsAlwaysArray(t *testing.T) {
	registry := NewRegistry(config.Config{})
	for _, raw := range registry.OpenAITools() {
		tool := raw.(map[string]any)
		function := tool["function"].(map[string]any)
		parameters := function["parameters"].(map[string]any)
		if _, ok := parameters["required"].([]string); !ok {
			t.Fatalf("tool %s required = %#v, want []string", function["name"], parameters["required"])
		}
	}
}

func TestFSToolsBlockOutsideAllowedRoot(t *testing.T) {
	allowed := t.TempDir()
	outside := t.TempDir()
	path := filepath.Join(outside, "file.txt")
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	registry := NewRegistry(config.Config{FSAllowedRoots: []string{allowed}})
	if _, err := registry.Call(context.Background(), "fs_stat_path", map[string]any{"path": path}); err == nil {
		t.Fatal("fs_stat_path error = nil, want outside-root error")
	}
}

func TestFSToolsAllowPathInsideAllowedRoot(t *testing.T) {
	allowed := t.TempDir()
	path := filepath.Join(allowed, "file.txt")
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	registry := NewRegistry(config.Config{FSAllowedRoots: []string{allowed}})
	if _, err := registry.Call(context.Background(), "fs_stat_path", map[string]any{"path": path}); err != nil {
		t.Fatalf("fs_stat_path error = %v", err)
	}
}

func TestSabnzbdHistoryRequestShape(t *testing.T) {
	var gotQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"history":{"slots":[]}}`))
	}))
	defer server.Close()

	registry := NewRegistry(config.Config{
		SabnzbdBaseURL: server.URL,
		SabnzbdAPIKey:  "secret",
	})
	if _, err := registry.Call(context.Background(), "sabnzbd_get_history", map[string]any{"limit": float64(5)}); err != nil {
		t.Fatalf("sabnzbd_get_history error = %v", err)
	}
	if gotQuery == "" {
		t.Fatal("server did not receive query")
	}
	for _, want := range []string{"mode=history", "output=json", "apikey=secret", "limit=5"} {
		if !containsQueryPart(gotQuery, want) {
			t.Fatalf("query %q missing %q", gotQuery, want)
		}
	}
}

func TestSonarrSearchEpisodeCommandShape(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v3/command" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":1}`))
	}))
	defer server.Close()

	registry := NewRegistry(config.Config{SonarrBaseURL: server.URL, SonarrAPIKey: "secret"})
	if _, err := registry.Call(context.Background(), "sonarr_search_episode", map[string]any{"episode_id": "123"}); err != nil {
		t.Fatalf("sonarr_search_episode error = %v", err)
	}
	if body["name"] != "EpisodeSearch" {
		t.Fatalf("command name = %v", body["name"])
	}
	ids := body["episodeIds"].([]any)
	if ids[0].(float64) != 123 {
		t.Fatalf("episodeIds = %#v", body["episodeIds"])
	}
}

func TestSonarrSearchSeasonCommandShape(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v3/command" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":1}`))
	}))
	defer server.Close()

	registry := NewRegistry(config.Config{SonarrBaseURL: server.URL, SonarrAPIKey: "secret"})
	if _, err := registry.Call(context.Background(), "sonarr_search_season", map[string]any{"series_id": "12", "season_number": "3"}); err != nil {
		t.Fatalf("sonarr_search_season error = %v", err)
	}
	if body["name"] != "SeasonSearch" {
		t.Fatalf("command name = %v", body["name"])
	}
	if body["seriesId"].(float64) != 12 || body["seasonNumber"].(float64) != 3 {
		t.Fatalf("body = %#v", body)
	}
}

func TestSonarrSearchSeriesCommandShape(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v3/command" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":1}`))
	}))
	defer server.Close()

	registry := NewRegistry(config.Config{SonarrBaseURL: server.URL, SonarrAPIKey: "secret"})
	if _, err := registry.Call(context.Background(), "sonarr_search_series", map[string]any{"series_id": "12"}); err != nil {
		t.Fatalf("sonarr_search_series error = %v", err)
	}
	if body["name"] != "SeriesSearch" {
		t.Fatalf("command name = %v", body["name"])
	}
	if body["seriesId"].(float64) != 12 {
		t.Fatalf("body = %#v", body)
	}
}

func TestRadarrSearchMovieCommandShape(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v3/command" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":1}`))
	}))
	defer server.Close()

	registry := NewRegistry(config.Config{RadarrBaseURL: server.URL, RadarrAPIKey: "secret"})
	if _, err := registry.Call(context.Background(), "radarr_search_movie", map[string]any{"movie_id": "456"}); err != nil {
		t.Fatalf("radarr_search_movie error = %v", err)
	}
	if body["name"] != "MoviesSearch" {
		t.Fatalf("command name = %v", body["name"])
	}
	ids := body["movieIds"].([]any)
	if ids[0].(float64) != 456 {
		t.Fatalf("movieIds = %#v", body["movieIds"])
	}
}

func TestSonarrDeleteBlocklistItemShape(t *testing.T) {
	var method, path string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method = r.Method
		path = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	registry := NewRegistry(config.Config{SonarrBaseURL: server.URL, SonarrAPIKey: "secret"})
	if _, err := registry.Call(context.Background(), "sonarr_delete_blocklist_item", map[string]any{"blocklist_id": "99"}); err != nil {
		t.Fatalf("sonarr_delete_blocklist_item error = %v", err)
	}
	if method != http.MethodDelete || path != "/api/v3/blocklist/99" {
		t.Fatalf("request = %s %s", method, path)
	}
}

func containsQueryPart(query, part string) bool {
	values, err := url.ParseQuery(query)
	if err != nil {
		return false
	}
	key, value, ok := strings.Cut(part, "=")
	return ok && values.Get(key) == value
}
