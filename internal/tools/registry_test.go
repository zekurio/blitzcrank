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

func TestWebSearchToolOnlyRegisteredWhenConfigured(t *testing.T) {
	if hasTool(NewRegistry(config.Config{}), "web_search") {
		t.Fatal("web_search registered without EXA_API_KEY")
	}
	if !hasTool(NewRegistry(config.Config{ExaAPIKey: "secret"}), "web_search") {
		t.Fatal("web_search not registered with EXA_API_KEY")
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

func TestSeerrResolveIssueRequestShape(t *testing.T) {
	var method, path string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method = r.Method
		path = r.URL.Path
		if r.Header.Get("X-Api-Key") != "secret" {
			t.Fatalf("X-Api-Key = %q", r.Header.Get("X-Api-Key"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":42,"status":"resolved"}`))
	}))
	defer server.Close()

	registry := NewRegistry(config.Config{SeerrBaseURL: server.URL, SeerrAPIKey: "secret"})
	if _, err := registry.Call(context.Background(), "seerr_resolve_issue", map[string]any{"issue_id": "42"}); err != nil {
		t.Fatalf("seerr_resolve_issue error = %v", err)
	}
	if method != http.MethodPost || path != "/api/v1/issue/42/resolved" {
		t.Fatalf("request = %s %s", method, path)
	}
}

func TestExaWebSearchRequestShape(t *testing.T) {
	var apiKey string
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/search" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		apiKey = r.Header.Get("x-api-key")
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"requestId":"req_123",
			"searchType":"neural",
			"costDollars":{"total":0.001},
			"results":[{
				"title":"Example",
				"url":"https://example.test",
				"publishedDate":"2026-05-16",
				"author":"Author",
				"highlights":["A relevant result"],
				"highlightScores":[0.91]
			}]
		}`))
	}))
	defer server.Close()

	registry := NewRegistry(config.Config{ExaBaseURL: server.URL, ExaAPIKey: "secret"})
	out, err := registry.Call(context.Background(), "web_search", map[string]any{"query": "project hail mary release", "limit": float64(3)})
	if err != nil {
		t.Fatalf("web_search error = %v", err)
	}
	if apiKey != "secret" {
		t.Fatalf("x-api-key = %q", apiKey)
	}
	if body["query"] != "project hail mary release" || body["type"] != "auto" || body["numResults"].(float64) != 3 {
		t.Fatalf("body = %#v", body)
	}
	contents := body["contents"].(map[string]any)
	if contents["highlights"] != true {
		t.Fatalf("contents = %#v", contents)
	}
	results := out.(map[string]any)["results"].([]map[string]any)
	if len(results) != 1 || results[0]["url"] != "https://example.test" {
		t.Fatalf("results = %#v", results)
	}
}

func TestExaWebSearchHTTPError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"Invalid API key"}`))
	}))
	defer server.Close()

	registry := NewRegistry(config.Config{ExaBaseURL: server.URL, ExaAPIKey: "secret"})
	_, err := registry.Call(context.Background(), "web_search", map[string]any{"query": "test"})
	if err == nil || !strings.Contains(err.Error(), "Invalid API key") {
		t.Fatalf("error = %v, want Exa HTTP error", err)
	}
}

func TestJellyfinItemMediaInfoSummarizesStreams(t *testing.T) {
	var rawQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/Items/abc" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		rawQuery = r.URL.RawQuery
		if r.Header.Get("X-Emby-Token") != "secret" {
			t.Fatalf("X-Emby-Token = %q", r.Header.Get("X-Emby-Token"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"Id":"abc",
			"Name":"Example Episode",
			"Type":"Episode",
			"MediaSources":[{
				"Id":"source1",
				"Container":"mkv",
				"MediaStreams":[
					{"Index":0,"Type":"Video","Codec":"hevc","Width":1920,"Height":1080},
					{"Index":1,"Type":"Audio","Codec":"aac","Language":"eng","DisplayTitle":"English - AAC - Stereo","Channels":2,"IsDefault":true},
					{"Index":2,"Type":"Subtitle","Language":"deu","DisplayTitle":"German","IsExternal":false}
				]
			}]
		}`))
	}))
	defer server.Close()

	registry := NewRegistry(config.Config{JellyfinBaseURL: server.URL, JellyfinAPIKey: "secret"})
	out, err := registry.Call(context.Background(), "jellyfin_get_item_media_info", map[string]any{"item_id": "abc"})
	if err != nil {
		t.Fatalf("jellyfin_get_item_media_info error = %v", err)
	}
	values, err := url.ParseQuery(rawQuery)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(values.Get("Fields"), "MediaSources") {
		t.Fatalf("Fields = %q, want MediaSources", values.Get("Fields"))
	}
	item := out.(map[string]any)
	sources := item["media_sources"].([]map[string]any)
	audio := sources[0]["audio_tracks"].([]map[string]any)
	if len(audio) != 1 || audio[0]["language"] != "eng" || audio[0]["channels"].(float64) != 2 {
		t.Fatalf("audio tracks = %#v", audio)
	}
}

func TestJellyfinChildMediaInfoRequestShape(t *testing.T) {
	var rawQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/Items" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		rawQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"Items":[],"TotalRecordCount":0}`))
	}))
	defer server.Close()

	registry := NewRegistry(config.Config{JellyfinBaseURL: server.URL, JellyfinAPIKey: "secret"})
	if _, err := registry.Call(context.Background(), "jellyfin_get_child_media_info", map[string]any{"item_id": "parent", "limit": float64(3)}); err != nil {
		t.Fatalf("jellyfin_get_child_media_info error = %v", err)
	}
	values, err := url.ParseQuery(rawQuery)
	if err != nil {
		t.Fatal(err)
	}
	if values.Get("ParentId") != "parent" || values.Get("Recursive") != "true" || values.Get("Limit") != "3" {
		t.Fatalf("query = %q", rawQuery)
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

func TestSonarrEpisodeFilesBySeriesRequestShape(t *testing.T) {
	var rawQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/v3/episodefile" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		rawQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[]`))
	}))
	defer server.Close()

	registry := NewRegistry(config.Config{SonarrBaseURL: server.URL, SonarrAPIKey: "secret"})
	if _, err := registry.Call(context.Background(), "sonarr_get_episode_files_by_series_id", map[string]any{"series_id": "12", "season_number": "3"}); err != nil {
		t.Fatalf("sonarr_get_episode_files_by_series_id error = %v", err)
	}
	values, err := url.ParseQuery(rawQuery)
	if err != nil {
		t.Fatal(err)
	}
	if values.Get("seriesId") != "12" || values.Get("seasonNumber") != "3" {
		t.Fatalf("query = %q", rawQuery)
	}
}

func TestSonarrEpisodeFileRequestShape(t *testing.T) {
	var method, path string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method = r.Method
		path = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":77}`))
	}))
	defer server.Close()

	registry := NewRegistry(config.Config{SonarrBaseURL: server.URL, SonarrAPIKey: "secret"})
	if _, err := registry.Call(context.Background(), "sonarr_get_episode_file", map[string]any{"episode_file_id": "77"}); err != nil {
		t.Fatalf("sonarr_get_episode_file error = %v", err)
	}
	if method != http.MethodGet || path != "/api/v3/episodefile/77" {
		t.Fatalf("request = %s %s", method, path)
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

func TestRadarrMovieFileRequestShape(t *testing.T) {
	var method, path string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method = r.Method
		path = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":88}`))
	}))
	defer server.Close()

	registry := NewRegistry(config.Config{RadarrBaseURL: server.URL, RadarrAPIKey: "secret"})
	if _, err := registry.Call(context.Background(), "radarr_get_movie_file", map[string]any{"movie_file_id": "88"}); err != nil {
		t.Fatalf("radarr_get_movie_file error = %v", err)
	}
	if method != http.MethodGet || path != "/api/v3/moviefile/88" {
		t.Fatalf("request = %s %s", method, path)
	}
}

func TestRadarrMovieByIDRequestShape(t *testing.T) {
	var method, path string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method = r.Method
		path = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":456}`))
	}))
	defer server.Close()

	registry := NewRegistry(config.Config{RadarrBaseURL: server.URL, RadarrAPIKey: "secret"})
	if _, err := registry.Call(context.Background(), "radarr_get_movie_by_id", map[string]any{"movie_id": "456"}); err != nil {
		t.Fatalf("radarr_get_movie_by_id error = %v", err)
	}
	if method != http.MethodGet || path != "/api/v3/movie/456" {
		t.Fatalf("request = %s %s", method, path)
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

func hasTool(registry *Registry, name string) bool {
	for _, raw := range registry.OpenAITools() {
		tool := raw.(map[string]any)
		function := tool["function"].(map[string]any)
		if function["name"] == name {
			return true
		}
	}
	return false
}
