package recommendation

import (
	"context"
	"errors"
	"math"
	"strings"
	"testing"
	"time"
)

type fakeCatalog struct {
	name  string
	items []Candidate
	err   error
}

func (f fakeCatalog) Name() string {
	return f.name
}

func (f fakeCatalog) Discover(context.Context, Query) ([]Candidate, error) {
	return append([]Candidate(nil), f.items...), f.err
}

type fakeProfileSource struct {
	profile Profile
	err     error
}

func (f fakeProfileSource) Profile(context.Context, string) (Profile, error) {
	return f.profile, f.err
}

type scoreByEvent map[string]float64

func (s scoreByEvent) Score(candidate Candidate, _ RankInput) float64 {
	return s[candidate.EventKey]
}

func TestEngineMergesFiltersSeenAndWeightsGenres(t *testing.T) {
	window := testWindow()
	animeInterested := testCandidate("anilist:anime:1", "anime-interested", MediaTypeAnime, ReleaseKindAiring, window.Start.AddDate(0, 0, 1))
	animeInterested.Genres = []string{"Science Fiction"}
	animeInterested.Popularity = 1
	animePopular := testCandidate("anilist:anime:2", "anime-popular", MediaTypeAnime, ReleaseKindAiring, window.Start.AddDate(0, 0, 2))
	animePopular.Genres = []string{"Action"}
	animePopular.Popularity = 100
	digital := testCandidate("tmdb:movie:3", "digital", MediaTypeMovie, ReleaseKindDigital, window.Start.AddDate(0, 0, 3))
	digital.Genres = []string{"Drama"}
	physical := testCandidate("tmdb:movie:4", "physical", MediaTypeMovie, ReleaseKindPhysical, window.Start.AddDate(0, 0, 4))
	seen := testCandidate("tmdb:movie:seen", "seen", MediaTypeMovie, ReleaseKindDigital, window.Start.AddDate(0, 0, 1))
	outOfWindow := testCandidate("tmdb:movie:late", "late", MediaTypeMovie, ReleaseKindDigital, window.End)
	invalid := testCandidate("tmdb:movie:invalid", "", MediaTypeMovie, ReleaseKindDigital, window.Start)

	duplicate := animeInterested
	duplicate.Overview = "merged overview"
	duplicate.Poster = "https://img.example/anime.jpg"
	duplicate.Genres = []string{"Adventure"}
	duplicate.Popularity = 5

	engine := NewEngine([]Catalog{
		fakeCatalog{name: "one", items: []Candidate{animeInterested, animePopular, digital, physical, seen, outOfWindow, invalid}},
		fakeCatalog{name: "two", items: []Candidate{duplicate}},
	}, fakeProfileSource{profile: Profile{
		SeenMediaKeys: []string{" TMDB:MOVIE:SEEN "},
		GenreWeights:  map[string]float64{"Drama": 2},
	}}, nil)

	result, err := engine.Recommend(context.Background(), Query{
		SubjectID: "user-1",
		Window:    window,
		Interests: map[string]float64{"sci fi": 10},
		MaxItems:  4,
	})
	if err != nil {
		t.Fatalf("Recommend() error = %v", err)
	}
	if len(result.Items) != 4 {
		t.Fatalf("items = %d, want 4: %#v", len(result.Items), result.Items)
	}
	if result.Items[0].EventKey != animeInterested.EventKey {
		t.Fatalf("first item = %q, want genre-weighted %q", result.Items[0].EventKey, animeInterested.EventKey)
	}

	byEvent := make(map[string]Candidate, len(result.Items))
	groups := make(map[candidateGroup]struct{})
	for _, item := range result.Items {
		byEvent[item.EventKey] = item
		groups[candidateGroup{mediaType: item.MediaType, releaseKind: item.ReleaseKind}] = struct{}{}
		if item.MediaKey == seen.MediaKey || item.EventKey == outOfWindow.EventKey {
			t.Fatalf("filtered candidate returned: %#v", item)
		}
	}
	if len(groups) != 3 {
		t.Fatalf("selected groups = %d, want all 3 groups before repeating: %#v", len(groups), result.Items)
	}
	merged := byEvent[animeInterested.EventKey]
	if merged.Overview != duplicate.Overview || merged.Poster != duplicate.Poster || merged.Popularity != duplicate.Popularity {
		t.Fatalf("merged candidate = %#v, want enriched duplicate fields", merged)
	}
	if got := strings.Join(merged.Genres, ","); got != "Adventure,Science Fiction" {
		t.Fatalf("merged genres = %q", got)
	}
	if !warningsContain(result.Warnings, "discarded 1 invalid") {
		t.Fatalf("warnings = %#v, want invalid candidate warning", result.Warnings)
	}
}

func TestEngineRoundRobinsRankedGroups(t *testing.T) {
	window := testWindow()
	a1 := testCandidate("anilist:anime:1", "a1", MediaTypeAnime, ReleaseKindAiring, window.Start)
	a2 := testCandidate("anilist:anime:2", "a2", MediaTypeAnime, ReleaseKindAiring, window.Start)
	a3 := testCandidate("anilist:anime:3", "a3", MediaTypeAnime, ReleaseKindAiring, window.Start)
	m1 := testCandidate("tmdb:movie:1", "m1", MediaTypeMovie, ReleaseKindDigital, window.Start)
	m2 := testCandidate("tmdb:movie:2", "m2", MediaTypeMovie, ReleaseKindDigital, window.Start)
	m3 := testCandidate("tmdb:movie:3", "m3", MediaTypeMovie, ReleaseKindDigital, window.Start)
	ranker := scoreByEvent{"a1": 100, "a2": 90, "a3": 80, "m1": 70, "m2": 60, "m3": 50}
	engine := NewEngine([]Catalog{fakeCatalog{name: "all", items: []Candidate{a3, m3, a2, m2, a1, m1}}}, nil, ranker)

	result, err := engine.Recommend(context.Background(), Query{Window: window, MaxItems: 4})
	if err != nil {
		t.Fatalf("Recommend() error = %v", err)
	}
	want := []string{"a1", "m1", "a2", "m2"}
	for i, eventKey := range want {
		if result.Items[i].EventKey != eventKey {
			t.Fatalf("items[%d] = %q, want %q; all=%#v", i, result.Items[i].EventKey, eventKey, result.Items)
		}
	}
}

func TestEngineKeepsPartialCatalogItemsAndWarnings(t *testing.T) {
	window := testWindow()
	partial := testCandidate("tmdb:movie:1", "partial", MediaTypeMovie, ReleaseKindDigital, window.Start)
	engine := NewEngine([]Catalog{
		fakeCatalog{name: "partial-source", items: []Candidate{partial}, err: errors.New("page two failed")},
		fakeCatalog{name: "failed-source", err: errors.New("unavailable")},
	}, fakeProfileSource{err: errors.New("profile unavailable")}, nil)

	result, err := engine.Recommend(context.Background(), Query{SubjectID: "user", Window: window})
	if err != nil {
		t.Fatalf("Recommend() error = %v", err)
	}
	if len(result.Items) != 1 || result.Items[0].EventKey != partial.EventKey {
		t.Fatalf("items = %#v, want partial catalog item", result.Items)
	}
	for _, text := range []string{"profile could not be loaded", "page two failed", "unavailable"} {
		if !warningsContain(result.Warnings, text) {
			t.Fatalf("warnings = %#v, want %q", result.Warnings, text)
		}
	}
}

func TestEngineRespectsFilters(t *testing.T) {
	window := testWindow()
	items := []Candidate{
		testCandidate("anilist:anime:1", "anime", MediaTypeAnime, ReleaseKindAiring, window.Start),
		testCandidate("tmdb:tv:2", "show", MediaTypeShow, ReleaseKindAiring, window.Start),
		testCandidate("tmdb:movie:3", "movie-digital", MediaTypeMovie, ReleaseKindDigital, window.Start),
		testCandidate("tmdb:movie:4", "movie-cinema", MediaTypeMovie, ReleaseKindTheatrical, window.Start),
	}
	engine := NewEngine([]Catalog{fakeCatalog{name: "all", items: items}}, nil, nil)

	result, err := engine.Recommend(context.Background(), Query{
		MediaTypes:   []MediaType{MediaTypeMovie},
		ReleaseKinds: []ReleaseKind{ReleaseKindTheatrical},
		Window:       window,
	})
	if err != nil {
		t.Fatalf("Recommend() error = %v", err)
	}
	if len(result.Items) != 1 || result.Items[0].EventKey != "movie-cinema" {
		t.Fatalf("items = %#v, want only theatrical movie", result.Items)
	}
}

func TestEngineValidatesQuery(t *testing.T) {
	window := testWindow()
	tests := []struct {
		name  string
		query Query
	}{
		{name: "missing window", query: Query{}},
		{name: "reversed window", query: Query{Window: Window{Start: window.End, End: window.Start}}},
		{name: "negative max", query: Query{Window: window, MaxItems: -1}},
		{name: "too many", query: Query{Window: window, MaxItems: maximumMaxItems + 1}},
		{name: "bad media", query: Query{Window: window, MediaTypes: []MediaType{"podcast"}}},
		{name: "bad release", query: Query{Window: window, ReleaseKinds: []ReleaseKind{"rental"}}},
		{name: "nan interest", query: Query{Window: window, Interests: map[string]float64{"Drama": math.NaN()}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			engine := NewEngine(nil, nil, nil)
			if _, err := engine.Recommend(context.Background(), test.query); err == nil {
				t.Fatal("Recommend() error = nil, want validation error")
			}
		})
	}
}

func TestEngineReturnsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	engine := NewEngine([]Catalog{fakeCatalog{name: "empty"}}, nil, nil)
	_, err := engine.Recommend(ctx, Query{Window: testWindow()})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Recommend() error = %v, want context.Canceled", err)
	}
}

func testWindow() Window {
	return Window{
		Start: time.Date(2026, 7, 10, 0, 0, 0, 0, time.UTC),
		End:   time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC),
	}
}

func testCandidate(mediaKey, eventKey string, mediaType MediaType, releaseKind ReleaseKind, releaseAt time.Time) Candidate {
	return Candidate{
		MediaKey:    mediaKey,
		EventKey:    eventKey,
		MediaType:   mediaType,
		ReleaseKind: releaseKind,
		Title:       eventKey,
		ReleaseAt:   releaseAt,
		Source:      "test",
	}
}

func warningsContain(warnings []Warning, text string) bool {
	for _, warning := range warnings {
		if strings.Contains(warning.Message, text) {
			return true
		}
	}
	return false
}

func TestNormalizeGenreSupportsLocalizedInterestAliases(t *testing.T) {
	tests := map[string]string{
		"Science-Fiction": "sci-fi",
		"Komödie":         "comedy",
		"Dokumentation":   "documentary",
		"Übernatürlich":   "supernatural",
		"Alltagsleben":    "slice of life",
	}
	for input, want := range tests {
		if got := normalizeGenre(input); got != want {
			t.Errorf("normalizeGenre(%q) = %q, want %q", input, got, want)
		}
	}
}
