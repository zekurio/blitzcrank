package recommendation

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

func TestTMDBCatalogDiscoversRegionalMovieReleaseKinds(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		if request.URL.Path != "/3/discover/movie" {
			t.Errorf("path = %q, want /3/discover/movie", request.URL.Path)
		}
		if got := request.Header.Get("Authorization"); got != "Bearer secret-token" {
			t.Errorf("Authorization = %q", got)
		}
		query := request.URL.Query()
		for key, want := range map[string]string{
			"include_adult":    "false",
			"include_video":    "false",
			"language":         "de-AT",
			"region":           "AT",
			"release_date.gte": "2026-07-10",
			"release_date.lte": "2026-07-19",
			"page":             "1",
		} {
			if got := query.Get(key); got != want {
				t.Errorf("query %s = %q, want %q", key, got, want)
			}
		}
		if strings.Contains(request.URL.RawQuery, "secret-token") || strings.Contains(request.URL.RawQuery, "discord-user") {
			t.Errorf("query leaked a secret or subject: %q", request.URL.RawQuery)
		}

		releaseTypes := query.Get("with_release_type")
		titleByType := map[string]string{
			"4":   "Digital Film",
			"5":   "Physical Film",
			"3|2": "Cinema Film",
		}
		title, ok := titleByType[releaseTypes]
		if !ok {
			t.Errorf("with_release_type = %q", releaseTypes)
			title = "Unknown"
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(writer, `{"page":1,"total_pages":1,"results":[{"id":42,"title":%q,"overview":"Localized overview","poster_path":"/poster.jpg","release_date":"2026-07-12","genre_ids":[28,12],"popularity":12.5}]}`, title)
	}))
	defer server.Close()

	catalog := newTestTMDBCatalog(t, server, 0)
	items, err := catalog.Discover(context.Background(), Query{
		SubjectID:  "discord-user",
		MediaTypes: []MediaType{MediaTypeMovie},
		Region:     "at",
		Locale:     "de-AT",
		Window:     testWindow(),
		MaxItems:   10,
	})
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	if calls.Load() != 3 {
		t.Fatalf("calls = %d, want one per release kind", calls.Load())
	}
	if len(items) != 3 {
		t.Fatalf("items = %d, want 3: %#v", len(items), items)
	}
	wantKinds := map[ReleaseKind]bool{
		ReleaseKindDigital:    false,
		ReleaseKindPhysical:   false,
		ReleaseKindTheatrical: false,
	}
	for _, item := range items {
		if item.MediaKey != "tmdb:movie:42" {
			t.Errorf("MediaKey = %q", item.MediaKey)
		}
		wantEvent := "tmdb:movie:42:" + string(item.ReleaseKind) + ":AT:2026-07-12"
		if item.EventKey != wantEvent {
			t.Errorf("EventKey = %q, want %q", item.EventKey, wantEvent)
		}
		if item.ReleaseAt.Format("2006-01-02") != "2026-07-12" || item.ReleaseAt.Location().String() != "UTC" {
			t.Errorf("ReleaseAt = %v", item.ReleaseAt)
		}
		if item.URL != "https://www.themoviedb.org/movie/42" || item.Poster != "https://image.tmdb.org/t/p/w500/poster.jpg" {
			t.Errorf("links = URL %q Poster %q", item.URL, item.Poster)
		}
		if got := strings.Join(item.Genres, ","); got != "Action,Adventure" {
			t.Errorf("Genres = %q", got)
		}
		if _, ok := wantKinds[item.ReleaseKind]; !ok {
			t.Errorf("unexpected ReleaseKind %q", item.ReleaseKind)
		}
		wantKinds[item.ReleaseKind] = true
	}
	for kind, found := range wantKinds {
		if !found {
			t.Errorf("release kind %q was not returned", kind)
		}
	}
}

func TestTMDBCatalogDiscoversGlobalShowPremieres(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/3/discover/tv" {
			t.Errorf("path = %q, want /3/discover/tv", request.URL.Path)
		}
		query := request.URL.Query()
		if query.Get("first_air_date.gte") != "2026-07-10" || query.Get("first_air_date.lte") != "2026-07-19" {
			t.Errorf("first-air window = %q .. %q", query.Get("first_air_date.gte"), query.Get("first_air_date.lte"))
		}
		if query.Has("region") || query.Has("with_release_type") || query.Has("release_date.gte") {
			t.Errorf("TV query contains movie-only filters: %q", request.URL.RawQuery)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"page":1,"total_pages":1,"results":[{"id":7,"name":"","original_name":"Original Show","overview":"Overview","poster_path":null,"first_air_date":"2026-07-15","genre_ids":[10759,10765],"popularity":9}]}`))
	}))
	defer server.Close()

	catalog := newTestTMDBCatalog(t, server, 0)
	items, err := catalog.Discover(context.Background(), Query{
		MediaTypes:   []MediaType{MediaTypeShow},
		ReleaseKinds: []ReleaseKind{ReleaseKindAiring},
		Region:       "AT",
		Window:       testWindow(),
	})
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("items = %#v", items)
	}
	item := items[0]
	if item.MediaKey != "tmdb:tv:7" || item.EventKey != "tmdb:tv:7:airing:global:2026-07-15" {
		t.Fatalf("keys = %q / %q", item.MediaKey, item.EventKey)
	}
	if item.Title != "Original Show" || item.Poster != "" {
		t.Fatalf("title/poster = %q / %q", item.Title, item.Poster)
	}
	if got := strings.Join(item.Genres, ","); got != "Action,Adventure,Fantasy,Sci-Fi" {
		t.Fatalf("genres = %q", got)
	}
}

func TestTMDBCatalogPaginatesDedupesAndFiltersDates(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		page, _ := strconv.Atoi(request.URL.Query().Get("page"))
		writer.Header().Set("Content-Type", "application/json")
		switch page {
		case 1:
			_, _ = writer.Write([]byte(`{"page":1,"total_pages":2,"results":[{"id":1,"title":"One","release_date":"2026-07-11","popularity":1},{"id":9,"title":"Outside","release_date":"2026-07-20","popularity":100}]}`))
		case 2:
			_, _ = writer.Write([]byte(`{"page":2,"total_pages":2,"results":[{"id":1,"title":"One duplicate","release_date":"2026-07-11","popularity":2},{"id":2,"title":"Two","release_date":"2026-07-12","popularity":3}]}`))
		default:
			t.Errorf("unexpected page %d", page)
		}
	}))
	defer server.Close()

	catalog := newTestTMDBCatalog(t, server, 0)
	items, err := catalog.Discover(context.Background(), Query{
		MediaTypes:   []MediaType{MediaTypeMovie},
		ReleaseKinds: []ReleaseKind{ReleaseKindDigital},
		Region:       "US",
		Window:       testWindow(),
		MaxItems:     2,
	})
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	if calls.Load() != 2 || len(items) != 2 {
		t.Fatalf("calls/items = %d/%d, want 2/2: %#v", calls.Load(), len(items), items)
	}
	if items[0].MediaKey != "tmdb:movie:1" || items[1].MediaKey != "tmdb:movie:2" {
		t.Fatalf("items = %#v, want deterministic unique events", items)
	}
}

func TestTMDBCatalogSkipsUnsupportedFiltersWithoutRequest(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		calls.Add(1)
	}))
	defer server.Close()
	catalog := newTestTMDBCatalog(t, server, 0)

	items, err := catalog.Discover(context.Background(), Query{
		MediaTypes:   []MediaType{MediaTypeAnime},
		ReleaseKinds: []ReleaseKind{ReleaseKindAiring},
		Window:       testWindow(),
	})
	if err != nil || len(items) != 0 || calls.Load() != 0 {
		t.Fatalf("Discover() = items %#v, error %v, calls %d", items, err, calls.Load())
	}
}

func TestTMDBCatalogRequiresRegionForMoviesButReturnsShows(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/3/discover/tv" {
			t.Errorf("unexpected path %q", request.URL.Path)
		}
		_, _ = writer.Write([]byte(`{"page":1,"total_pages":1,"results":[{"id":8,"name":"Show","first_air_date":"2026-07-11"}]}`))
	}))
	defer server.Close()
	catalog := newTestTMDBCatalog(t, server, 0)

	items, err := catalog.Discover(context.Background(), Query{Window: testWindow()})
	if err == nil || !strings.Contains(err.Error(), "requires a release region") {
		t.Fatalf("Discover() error = %v", err)
	}
	if len(items) != 1 || items[0].MediaType != MediaTypeShow {
		t.Fatalf("items = %#v, want partial show result", items)
	}
}

func TestTMDBCatalogBoundsAndSanitizesResponses(t *testing.T) {
	tests := []struct {
		name      string
		status    int
		body      string
		limit     int64
		wantError string
	}{
		{name: "http error", status: http.StatusUnauthorized, body: "PRIVATE-BODY secret-token", wantError: "HTTP 401"},
		{name: "oversized", status: http.StatusOK, body: strings.Repeat("PRIVATE-BODY", 20), limit: 20, wantError: "exceeded 20 bytes"},
		{name: "invalid json", status: http.StatusOK, body: "PRIVATE-BODY", wantError: "decode TMDB response"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				writer.WriteHeader(test.status)
				_, _ = writer.Write([]byte(test.body))
			}))
			defer server.Close()
			catalog := newTestTMDBCatalog(t, server, test.limit)

			_, err := catalog.Discover(context.Background(), Query{
				MediaTypes:   []MediaType{MediaTypeMovie},
				ReleaseKinds: []ReleaseKind{ReleaseKindDigital},
				Region:       "AT",
				Window:       testWindow(),
			})
			if err == nil || !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("Discover() error = %v, want %q", err, test.wantError)
			}
			if strings.Contains(err.Error(), "PRIVATE-BODY") || strings.Contains(err.Error(), "secret-token") {
				t.Fatalf("error leaked response body or token: %v", err)
			}
		})
	}
}

func TestNewTMDBCatalogRequiresBearerToken(t *testing.T) {
	if _, err := NewTMDBCatalog(TMDBCatalogOptions{}); err == nil {
		t.Fatal("NewTMDBCatalog() error = nil, want missing token error")
	}
}

func newTestTMDBCatalog(t *testing.T, server *httptest.Server, limit int64) *TMDBCatalog {
	t.Helper()
	catalog, err := NewTMDBCatalog(TMDBCatalogOptions{
		BaseURL:          server.URL,
		BearerToken:      "secret-token",
		HTTPClient:       server.Client(),
		MaxResponseBytes: limit,
	})
	if err != nil {
		t.Fatalf("NewTMDBCatalog() error = %v", err)
	}
	return catalog
}
