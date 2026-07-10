package recommendation

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestAniListCatalogDiscoversAnimeStartDatesAndPaginates(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		if request.Method != http.MethodPost || request.URL.Path != "/" {
			t.Errorf("request = %s %s, want POST /", request.Method, request.URL.Path)
		}
		if request.Header.Get("Authorization") != "" {
			t.Errorf("unexpected Authorization header")
		}
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatalf("read request: %v", err)
		}
		if strings.Contains(string(body), "discord-user") {
			t.Errorf("request body leaked SubjectID: %s", body)
		}
		var payload struct {
			Query     string         `json:"query"`
			Variables map[string]int `json:"variables"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		for _, queryPart := range []string{"type: ANIME", "startDate_greater", "startDate_lesser", "isAdult: false"} {
			if !strings.Contains(payload.Query, queryPart) {
				t.Errorf("GraphQL query missing %q", queryPart)
			}
		}
		if payload.Variables["startDateGreater"] != 20260709 || payload.Variables["startDateLesser"] != 20260720 {
			t.Errorf("date variables = %#v", payload.Variables)
		}
		writer.Header().Set("Content-Type", "application/json")
		switch payload.Variables["page"] {
		case 1:
			_, _ = writer.Write([]byte(`{"data":{"Page":{"pageInfo":{"hasNextPage":true},"media":[{"id":10,"title":{"english":"English Anime","romaji":"Romaji Anime","native":"日本語アニメ"},"description":"Overview","siteUrl":"https://anilist.co/anime/10","coverImage":{"extraLarge":"","large":"https://img.example/10.jpg"},"startDate":{"year":2026,"month":7,"day":12},"genres":["Sci-Fi","Action"],"popularity":200},{"id":11,"title":{"english":"Incomplete"},"startDate":{"year":2026,"month":7,"day":0}}]}}}`))
		case 2:
			_, _ = writer.Write([]byte(`{"data":{"Page":{"pageInfo":{"hasNextPage":false},"media":[{"id":12,"title":{"userPreferred":"Preferred Anime","english":"English Second"},"coverImage":{"extraLarge":"https://img.example/12-xl.jpg"},"startDate":{"year":2026,"month":7,"day":11},"genres":["Drama"],"popularity":100}]}}}`))
		default:
			t.Errorf("unexpected page %d", payload.Variables["page"])
		}
	}))
	defer server.Close()

	catalog := newTestAniListCatalog(t, server, 0)
	items, err := catalog.Discover(context.Background(), Query{
		SubjectID:    "discord-user",
		MediaTypes:   []MediaType{MediaTypeAnime},
		ReleaseKinds: []ReleaseKind{ReleaseKindAiring},
		Locale:       "ja-JP",
		Window:       testWindow(),
		MaxItems:     2,
	})
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	if calls.Load() != 2 || len(items) != 2 {
		t.Fatalf("calls/items = %d/%d, want 2/2: %#v", calls.Load(), len(items), items)
	}
	if items[0].MediaKey != "anilist:anime:12" || items[0].EventKey != "anilist:anime:12:airing:global:2026-07-11" {
		t.Fatalf("first keys = %q / %q", items[0].MediaKey, items[0].EventKey)
	}
	if items[0].Title != "Preferred Anime" || items[0].Poster != "https://img.example/12-xl.jpg" {
		t.Fatalf("first title/poster = %q / %q", items[0].Title, items[0].Poster)
	}
	if items[1].Title != "日本語アニメ" || items[1].Poster != "https://img.example/10.jpg" {
		t.Fatalf("second title/poster = %q / %q", items[1].Title, items[1].Poster)
	}
	if got := strings.Join(items[1].Genres, ","); got != "Action,Sci-Fi" {
		t.Fatalf("genres = %q", got)
	}
}

func TestAniListCatalogUsesEnglishLocaleFallback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{"data":{"Page":{"pageInfo":{"hasNextPage":false},"media":[{"id":1,"title":{"userPreferred":"Preferred","english":"English","romaji":"Romaji","native":"Native"},"startDate":{"year":2026,"month":7,"day":12}}]}}}`))
	}))
	defer server.Close()
	catalog := newTestAniListCatalog(t, server, 0)

	items, err := catalog.Discover(context.Background(), Query{Locale: "en-US", Window: testWindow()})
	if err != nil || len(items) != 1 {
		t.Fatalf("Discover() = %#v, %v", items, err)
	}
	if items[0].Title != "English" {
		t.Fatalf("Title = %q, want English", items[0].Title)
	}
}

func TestAniListCatalogSkipsUnsupportedFiltersWithoutRequest(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		calls.Add(1)
	}))
	defer server.Close()
	catalog := newTestAniListCatalog(t, server, 0)

	items, err := catalog.Discover(context.Background(), Query{
		MediaTypes:   []MediaType{MediaTypeMovie},
		ReleaseKinds: []ReleaseKind{ReleaseKindDigital},
		Window:       testWindow(),
	})
	if err != nil || len(items) != 0 || calls.Load() != 0 {
		t.Fatalf("Discover() = items %#v, error %v, calls %d", items, err, calls.Load())
	}
}

func TestAniListCatalogReturnsPartialDataWithoutLeakingGraphQLError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{"data":{"Page":{"pageInfo":{"hasNextPage":false},"media":[{"id":1,"title":{"english":"Anime"},"startDate":{"year":2026,"month":7,"day":12}}]}},"errors":[{"message":"PRIVATE-GRAPHQL-DIAGNOSTIC"}]}`))
	}))
	defer server.Close()
	catalog := newTestAniListCatalog(t, server, 0)

	items, err := catalog.Discover(context.Background(), Query{Window: testWindow()})
	if err == nil || !strings.Contains(err.Error(), "GraphQL returned errors") {
		t.Fatalf("Discover() error = %v", err)
	}
	if strings.Contains(err.Error(), "PRIVATE-GRAPHQL-DIAGNOSTIC") {
		t.Fatalf("error leaked GraphQL response: %v", err)
	}
	if len(items) != 1 || items[0].MediaKey != "anilist:anime:1" {
		t.Fatalf("items = %#v, want partial data", items)
	}
}

func TestAniListCatalogBoundsAndSanitizesResponses(t *testing.T) {
	tests := []struct {
		name      string
		status    int
		body      string
		limit     int64
		wantError string
	}{
		{name: "http error", status: http.StatusTooManyRequests, body: "PRIVATE-BODY", wantError: "HTTP 429"},
		{name: "oversized", status: http.StatusOK, body: strings.Repeat("PRIVATE-BODY", 20), limit: 20, wantError: "exceeded 20 bytes"},
		{name: "invalid json", status: http.StatusOK, body: "PRIVATE-BODY", wantError: "decode AniList response"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				writer.WriteHeader(test.status)
				_, _ = writer.Write([]byte(test.body))
			}))
			defer server.Close()
			catalog := newTestAniListCatalog(t, server, test.limit)

			_, err := catalog.Discover(context.Background(), Query{Window: testWindow()})
			if err == nil || !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("Discover() error = %v, want %q", err, test.wantError)
			}
			if strings.Contains(err.Error(), "PRIVATE-BODY") {
				t.Fatalf("error leaked response body: %v", err)
			}
		})
	}
}

func TestNewAniListCatalogRejectsInvalidEndpoint(t *testing.T) {
	if _, err := NewAniListCatalog(AniListCatalogOptions{Endpoint: "file:///tmp/anilist"}); err == nil {
		t.Fatal("NewAniListCatalog() error = nil, want invalid endpoint error")
	}
}

func newTestAniListCatalog(t *testing.T, server *httptest.Server, limit int64) *AniListCatalog {
	t.Helper()
	catalog, err := NewAniListCatalog(AniListCatalogOptions{
		Endpoint:         server.URL,
		HTTPClient:       server.Client(),
		MaxResponseBytes: limit,
	})
	if err != nil {
		t.Fatalf("NewAniListCatalog() error = %v", err)
	}
	return catalog
}
