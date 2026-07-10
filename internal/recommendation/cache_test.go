package recommendation

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type countingCatalog struct {
	calls atomic.Int32
	mu    sync.Mutex
	query Query
	items []Candidate
	err   error
}

func (c *countingCatalog) Name() string {
	return "counting"
}

func (c *countingCatalog) Discover(_ context.Context, query Query) ([]Candidate, error) {
	c.calls.Add(1)
	c.mu.Lock()
	c.query = query
	c.mu.Unlock()
	return cloneCandidates(c.items), c.err
}

func (c *countingCatalog) lastQuery() Query {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.query
}

func TestCachedCatalogNormalizesProviderKeyAndProtectsValues(t *testing.T) {
	window := testWindow()
	item := testCandidate("tmdb:movie:1", "event", MediaTypeMovie, ReleaseKindDigital, window.Start)
	item.Genres = []string{"Drama"}
	upstream := &countingCatalog{items: []Candidate{item}}
	cached, err := NewCachedCatalog(upstream, CacheOptions{TTL: time.Minute, MaxEntries: 8})
	if err != nil {
		t.Fatalf("NewCachedCatalog() error = %v", err)
	}
	local := time.FixedZone("local", 2*60*60)
	firstQuery := Query{
		SubjectID:    "user-one",
		MediaTypes:   []MediaType{MediaTypeMovie, MediaTypeAnime, MediaTypeMovie},
		ReleaseKinds: []ReleaseKind{ReleaseKindPhysical, ReleaseKindDigital, ReleaseKindPhysical},
		Region:       " at ",
		Locale:       "de-AT",
		Window: Window{
			Start: window.Start.In(local),
			End:   window.End.In(local),
		},
		Interests: map[string]float64{"Drama": 4},
		MaxItems:  4,
	}
	first, err := cached.Discover(context.Background(), firstQuery)
	if err != nil {
		t.Fatalf("first Discover() error = %v", err)
	}
	first[0].Title = "mutated"
	first[0].Genres[0] = "mutated"

	second, err := cached.Discover(context.Background(), Query{
		SubjectID:    "user-two",
		MediaTypes:   []MediaType{MediaTypeAnime, MediaTypeMovie},
		ReleaseKinds: []ReleaseKind{ReleaseKindDigital, ReleaseKindPhysical},
		Region:       "AT",
		Locale:       "DE-at",
		Window:       window,
		Interests:    map[string]float64{"Comedy": 99},
		MaxItems:     4,
	})
	if err != nil {
		t.Fatalf("second Discover() error = %v", err)
	}
	if upstream.calls.Load() != 1 {
		t.Fatalf("upstream calls = %d, want 1", upstream.calls.Load())
	}
	if second[0].Title != item.Title || second[0].Genres[0] != "Drama" {
		t.Fatalf("cached value was mutated by caller: %#v", second[0])
	}
	providerQuery := upstream.lastQuery()
	if providerQuery.SubjectID != "" || providerQuery.Interests != nil {
		t.Fatalf("provider query contains personalization: %#v", providerQuery)
	}
	if !reflect.DeepEqual(providerQuery.MediaTypes, []MediaType{MediaTypeAnime, MediaTypeMovie}) {
		t.Fatalf("provider media types = %#v", providerQuery.MediaTypes)
	}
	if !reflect.DeepEqual(providerQuery.ReleaseKinds, []ReleaseKind{ReleaseKindDigital, ReleaseKindPhysical}) {
		t.Fatalf("provider release kinds = %#v", providerQuery.ReleaseKinds)
	}
	if providerQuery.Region != "AT" || !providerQuery.Window.Start.Equal(window.Start) || !providerQuery.Window.End.Equal(window.End) {
		t.Fatalf("provider query normalization = %#v", providerQuery)
	}
}

func TestCachedCatalogExpiresAndUsesLRUEviction(t *testing.T) {
	now := time.Date(2026, 7, 10, 0, 0, 0, 0, time.UTC)
	upstream := &countingCatalog{}
	cached, err := NewCachedCatalog(upstream, CacheOptions{
		TTL:        10 * time.Minute,
		MaxEntries: 2,
		Now:        func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewCachedCatalog() error = %v", err)
	}
	query := Query{MediaTypes: []MediaType{MediaTypeAnime}, Window: testWindow()}

	if _, err := cached.Discover(context.Background(), query); err != nil {
		t.Fatal(err)
	}
	now = now.Add(9 * time.Minute)
	if _, err := cached.Discover(context.Background(), query); err != nil {
		t.Fatal(err)
	}
	if upstream.calls.Load() != 1 {
		t.Fatalf("calls before expiry = %d, want 1", upstream.calls.Load())
	}
	now = now.Add(2 * time.Minute)
	if _, err := cached.Discover(context.Background(), query); err != nil {
		t.Fatal(err)
	}
	if upstream.calls.Load() != 2 {
		t.Fatalf("calls after expiry = %d, want 2", upstream.calls.Load())
	}

	queryAT := query
	queryAT.Region = "AT"
	queryUS := query
	queryUS.Region = "US"
	queryDE := query
	queryDE.Region = "DE"
	for _, current := range []Query{queryAT, queryUS, queryAT, queryDE, queryUS} {
		if _, err := cached.Discover(context.Background(), current); err != nil {
			t.Fatal(err)
		}
	}
	// The sequence loads AT and US, touches AT, evicts US for DE, then reloads
	// US. Together with the two pre-existing unscoped loads this totals six.
	if upstream.calls.Load() != 6 {
		t.Fatalf("calls after LRU sequence = %d, want 6", upstream.calls.Load())
	}
	cached.cache.mu.Lock()
	entryCount := len(cached.cache.entries) + len(cached.cache.inFlight)
	cached.cache.mu.Unlock()
	if entryCount > 2 {
		t.Fatalf("tracked cache entries = %d, want at most 2", entryCount)
	}
}

type blockingCatalog struct {
	calls   atomic.Int32
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (c *blockingCatalog) Name() string {
	return "blocking"
}

func (c *blockingCatalog) Discover(ctx context.Context, query Query) ([]Candidate, error) {
	c.calls.Add(1)
	c.once.Do(func() { close(c.started) })
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-c.release:
	}
	return []Candidate{testCandidate("tmdb:tv:1", "event", MediaTypeShow, ReleaseKindAiring, query.Window.Start)}, nil
}

func TestCachedCatalogCoalescesConcurrentRequests(t *testing.T) {
	upstream := &blockingCatalog{started: make(chan struct{}), release: make(chan struct{})}
	cached, err := NewCachedCatalog(upstream, CacheOptions{TTL: time.Minute, MaxEntries: 8})
	if err != nil {
		t.Fatalf("NewCachedCatalog() error = %v", err)
	}
	query := Query{MediaTypes: []MediaType{MediaTypeShow}, Window: testWindow()}

	const callers = 12
	results := make(chan error, callers)
	for index := range callers {
		go func(index int) {
			current := query
			current.SubjectID = "user-" + time.Duration(index).String()
			current.Interests = map[string]float64{"Drama": float64(index)}
			items, err := cached.Discover(context.Background(), current)
			if err == nil && (len(items) != 1 || items[0].EventKey != "event") {
				err = errors.New("unexpected cached result")
			}
			results <- err
		}(index)
	}
	select {
	case <-upstream.started:
	case <-time.After(time.Second):
		t.Fatal("upstream request did not start")
	}
	close(upstream.release)
	for range callers {
		select {
		case err := <-results:
			if err != nil {
				t.Fatalf("concurrent Discover() error = %v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("concurrent Discover() did not return")
		}
	}
	if upstream.calls.Load() != 1 {
		t.Fatalf("upstream calls = %d, want one coalesced request", upstream.calls.Load())
	}
}

func TestCachedCatalogDoesNotCacheErrors(t *testing.T) {
	upstream := &countingCatalog{err: errors.New("offline")}
	cached, err := NewCachedCatalog(upstream, CacheOptions{TTL: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	query := Query{MediaTypes: []MediaType{MediaTypeAnime}, Window: testWindow()}
	for range 2 {
		if _, err := cached.Discover(context.Background(), query); err == nil {
			t.Fatal("Discover() error = nil, want upstream error")
		}
	}
	if upstream.calls.Load() != 2 {
		t.Fatalf("upstream calls = %d, want errors not to be cached", upstream.calls.Load())
	}
}

type countingProfileSource struct {
	calls   atomic.Int32
	profile Profile
}

type invalidatedProfileSource struct {
	calls        atomic.Int32
	firstStarted chan struct{}
	firstRelease chan struct{}
}

func (s *invalidatedProfileSource) Profile(context.Context, string) (Profile, error) {
	call := s.calls.Add(1)
	if call == 1 {
		close(s.firstStarted)
		<-s.firstRelease
		return Profile{SeenMediaKeys: []string{"old"}}, nil
	}
	return Profile{SeenMediaKeys: []string{"new"}}, nil
}

func (s *countingProfileSource) Profile(context.Context, string) (Profile, error) {
	s.calls.Add(1)
	return cloneProfile(s.profile), nil
}

func TestCachedProfileSourceCachesByTrimmedSubjectAndClones(t *testing.T) {
	now := time.Date(2026, 7, 10, 0, 0, 0, 0, time.UTC)
	upstream := &countingProfileSource{profile: Profile{
		SeenMediaKeys: []string{"tmdb:movie:1"},
		GenreWeights:  map[string]float64{"Drama": 2},
	}}
	cached, err := NewCachedProfileSource(upstream, CacheOptions{
		TTL:        15 * time.Minute,
		MaxEntries: 4,
		Now:        func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewCachedProfileSource() error = %v", err)
	}
	first, err := cached.Profile(context.Background(), " user ")
	if err != nil {
		t.Fatal(err)
	}
	first.SeenMediaKeys[0] = "mutated"
	first.GenreWeights["Drama"] = 99
	second, err := cached.Profile(context.Background(), "user")
	if err != nil {
		t.Fatal(err)
	}
	if upstream.calls.Load() != 1 {
		t.Fatalf("profile calls = %d, want 1", upstream.calls.Load())
	}
	if second.SeenMediaKeys[0] != "tmdb:movie:1" || second.GenreWeights["Drama"] != 2 {
		t.Fatalf("cached profile was mutated: %#v", second)
	}
	cached.Invalidate(" user ")
	if _, err := cached.Profile(context.Background(), "user"); err != nil {
		t.Fatal(err)
	}
	if upstream.calls.Load() != 2 {
		t.Fatalf("profile calls after invalidation = %d, want 2", upstream.calls.Load())
	}
	now = now.Add(16 * time.Minute)
	if _, err := cached.Profile(context.Background(), "user"); err != nil {
		t.Fatal(err)
	}
	if upstream.calls.Load() != 3 {
		t.Fatalf("profile calls after expiry = %d, want 3", upstream.calls.Load())
	}
}

func TestCachedProfileInvalidationDetachesInFlightLoad(t *testing.T) {
	upstream := &invalidatedProfileSource{firstStarted: make(chan struct{}), firstRelease: make(chan struct{})}
	cached, err := NewCachedProfileSource(upstream, CacheOptions{TTL: time.Minute, MaxEntries: 4})
	if err != nil {
		t.Fatal(err)
	}
	firstResult := make(chan Profile, 1)
	go func() {
		profile, _ := cached.Profile(context.Background(), "user")
		firstResult <- profile
	}()
	select {
	case <-upstream.firstStarted:
	case <-time.After(time.Second):
		t.Fatal("first profile load did not start")
	}
	cached.Invalidate("user")
	second, err := cached.Profile(context.Background(), "user")
	if err != nil || len(second.SeenMediaKeys) != 1 || second.SeenMediaKeys[0] != "new" {
		t.Fatalf("second Profile() = %#v, %v", second, err)
	}
	close(upstream.firstRelease)
	select {
	case first := <-firstResult:
		if len(first.SeenMediaKeys) != 1 || first.SeenMediaKeys[0] != "old" {
			t.Fatalf("first Profile() = %#v", first)
		}
	case <-time.After(time.Second):
		t.Fatal("first profile load did not finish")
	}
	third, err := cached.Profile(context.Background(), "user")
	if err != nil || len(third.SeenMediaKeys) != 1 || third.SeenMediaKeys[0] != "new" || upstream.calls.Load() != 2 {
		t.Fatalf("third Profile() = %#v, %v; calls=%d", third, err, upstream.calls.Load())
	}
}

func TestCacheConstructorsValidateOptions(t *testing.T) {
	if _, err := NewCachedCatalog(nil, CacheOptions{}); err == nil {
		t.Fatal("NewCachedCatalog(nil) error = nil")
	}
	if _, err := NewCachedProfileSource(nil, CacheOptions{}); err == nil {
		t.Fatal("NewCachedProfileSource(nil) error = nil")
	}
	if _, err := NewCachedCatalog(&countingCatalog{}, CacheOptions{TTL: -time.Second}); err == nil {
		t.Fatal("negative TTL error = nil")
	}
	if _, err := NewCachedCatalog(&countingCatalog{}, CacheOptions{MaxEntries: -1}); err == nil {
		t.Fatal("negative max entries error = nil")
	}
	if _, err := NewCachedCatalog(&countingCatalog{}, CacheOptions{MaxEntries: maximumCacheEntries + 1}); err == nil {
		t.Fatal("oversized max entries error = nil")
	}
	cached, err := NewCachedCatalog(&countingCatalog{}, CacheOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if cached.cache.ttl != DefaultCatalogCacheTTL || cached.cache.maxEntries != defaultCacheEntries {
		t.Fatalf("default cache options = TTL %v max %d", cached.cache.ttl, cached.cache.maxEntries)
	}
}
