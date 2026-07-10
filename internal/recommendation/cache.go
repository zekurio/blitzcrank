package recommendation

import (
	"context"
	"errors"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	DefaultCatalogCacheTTL = 10 * time.Minute
	DefaultProfileCacheTTL = 15 * time.Minute
	defaultCacheEntries    = 256
	maximumCacheEntries    = 4096
)

type CacheOptions struct {
	TTL        time.Duration
	MaxEntries int
	Now        func() time.Time
}

// CachedCatalog caches only provider inputs. SubjectID and Interests are
// deliberately cleared before the wrapped catalog is called, because they
// affect profile filtering/ranking rather than upstream discovery.
type CachedCatalog struct {
	catalog Catalog
	cache   *memoryCache[[]Candidate]
}

func NewCachedCatalog(catalog Catalog, options CacheOptions) (*CachedCatalog, error) {
	if catalog == nil {
		return nil, errors.New("cached catalog requires a catalog")
	}
	cache, err := newMemoryCache(options, DefaultCatalogCacheTTL, cloneCandidates)
	if err != nil {
		return nil, err
	}
	return &CachedCatalog{catalog: catalog, cache: cache}, nil
}

func (c *CachedCatalog) Name() string {
	return c.catalog.Name()
}

func (c *CachedCatalog) Discover(ctx context.Context, query Query) ([]Candidate, error) {
	providerQuery, err := providerCatalogQuery(query)
	if err != nil {
		return nil, err
	}
	key := catalogCacheKey(providerQuery)
	return c.cache.getOrLoad(ctx, key, func(ctx context.Context) ([]Candidate, error) {
		return c.catalog.Discover(ctx, providerQuery)
	})
}

// CachedProfileSource avoids repeating a user's media-history read when that
// user has multiple subscriptions or concurrent previews.
type CachedProfileSource struct {
	source ProfileSource
	cache  *memoryCache[Profile]
}

func NewCachedProfileSource(source ProfileSource, options CacheOptions) (*CachedProfileSource, error) {
	if source == nil {
		return nil, errors.New("cached profile source requires a profile source")
	}
	cache, err := newMemoryCache(options, DefaultProfileCacheTTL, cloneProfile)
	if err != nil {
		return nil, err
	}
	return &CachedProfileSource{source: source, cache: cache}, nil
}

func (c *CachedProfileSource) Profile(ctx context.Context, subjectID string) (Profile, error) {
	subjectID = strings.TrimSpace(subjectID)
	return c.cache.getOrLoad(ctx, subjectID, func(ctx context.Context) (Profile, error) {
		return c.source.Profile(ctx, subjectID)
	})
}

// Invalidate removes a linked user's cached profile immediately after link or
// unlink changes. Watch-history changes otherwise expire on the normal TTL.
func (c *CachedProfileSource) Invalidate(subjectID string) {
	if c == nil || c.cache == nil {
		return
	}
	c.cache.remove(strings.TrimSpace(subjectID))
}

type memoryCache[T any] struct {
	mu         sync.Mutex
	entries    map[string]memoryCacheEntry[T]
	inFlight   map[string]*memoryCacheCall[T]
	ttl        time.Duration
	maxEntries int
	now        func() time.Time
	clone      func(T) T
	sequence   uint64
}

type memoryCacheEntry[T any] struct {
	value     T
	expiresAt time.Time
	sequence  uint64
}

type memoryCacheCall[T any] struct {
	done  chan struct{}
	value T
	err   error
}

func newMemoryCache[T any](options CacheOptions, defaultTTL time.Duration, clone func(T) T) (*memoryCache[T], error) {
	ttl := options.TTL
	if ttl == 0 {
		ttl = defaultTTL
	}
	if ttl < 0 {
		return nil, errors.New("cache TTL must not be negative")
	}
	maxEntries := options.MaxEntries
	if maxEntries == 0 {
		maxEntries = defaultCacheEntries
	}
	if maxEntries < 0 {
		return nil, errors.New("cache max entries must not be negative")
	}
	if maxEntries > maximumCacheEntries {
		return nil, errors.New("cache max entries must not exceed 4096")
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &memoryCache[T]{
		entries:    make(map[string]memoryCacheEntry[T], maxEntries),
		inFlight:   make(map[string]*memoryCacheCall[T]),
		ttl:        ttl,
		maxEntries: maxEntries,
		now:        now,
		clone:      clone,
	}, nil
}

func (c *memoryCache[T]) getOrLoad(ctx context.Context, key string, load func(context.Context) (T, error)) (T, error) {
	now := c.now()
	c.mu.Lock()
	if entry, ok := c.entries[key]; ok {
		if now.Before(entry.expiresAt) {
			c.sequence++
			entry.sequence = c.sequence
			c.entries[key] = entry
			value := c.clone(entry.value)
			c.mu.Unlock()
			return value, nil
		}
		delete(c.entries, key)
	}
	if call, ok := c.inFlight[key]; ok {
		c.mu.Unlock()
		select {
		case <-ctx.Done():
			var zero T
			return zero, ctx.Err()
		case <-call.done:
			return c.clone(call.value), call.err
		}
	}

	c.makeRoomLocked(now)
	if len(c.entries)+len(c.inFlight) >= c.maxEntries {
		// All bounded slots are occupied by in-flight calls. Avoid growing the
		// tracking maps; this request proceeds uncached.
		c.mu.Unlock()
		value, err := load(ctx)
		return c.clone(value), err
	}
	call := &memoryCacheCall[T]{done: make(chan struct{})}
	c.inFlight[key] = call
	c.mu.Unlock()

	value, err := load(ctx)
	c.mu.Lock()
	call.value = c.clone(value)
	call.err = err
	active := c.inFlight[key] == call
	if active {
		delete(c.inFlight, key)
	}
	if err == nil && active {
		c.sequence++
		c.entries[key] = memoryCacheEntry[T]{
			value:     c.clone(value),
			expiresAt: c.now().Add(c.ttl),
			sequence:  c.sequence,
		}
	}
	close(call.done)
	c.mu.Unlock()
	return c.clone(value), err
}

func (c *memoryCache[T]) makeRoomLocked(now time.Time) {
	for key, entry := range c.entries {
		if !now.Before(entry.expiresAt) {
			delete(c.entries, key)
		}
	}
	for len(c.entries)+len(c.inFlight) >= c.maxEntries && len(c.entries) > 0 {
		var oldestKey string
		var oldestSequence uint64
		first := true
		for key, entry := range c.entries {
			if first || entry.sequence < oldestSequence {
				oldestKey = key
				oldestSequence = entry.sequence
				first = false
			}
		}
		delete(c.entries, oldestKey)
	}
}

func (c *memoryCache[T]) remove(key string) {
	c.mu.Lock()
	delete(c.entries, key)
	// Detach an in-flight load. Existing waiters still receive its result, but
	// a request after invalidation starts a fresh load and the detached result
	// cannot repopulate the cache when it completes.
	delete(c.inFlight, key)
	c.mu.Unlock()
}

func providerCatalogQuery(query Query) (Query, error) {
	query, err := normalizeQuery(query)
	if err != nil {
		return Query{}, err
	}
	query.SubjectID = ""
	query.Interests = nil
	query.MediaTypes = normalizedMediaTypes(query.MediaTypes)
	query.ReleaseKinds = normalizedReleaseKinds(query.ReleaseKinds)
	return query, nil
}

func catalogCacheKey(query Query) string {
	mediaTypes := make([]string, 0, len(query.MediaTypes))
	for _, mediaType := range query.MediaTypes {
		mediaTypes = append(mediaTypes, string(mediaType))
	}
	releaseKinds := make([]string, 0, len(query.ReleaseKinds))
	for _, releaseKind := range query.ReleaseKinds {
		releaseKinds = append(releaseKinds, string(releaseKind))
	}
	return strings.Join([]string{
		strings.Join(mediaTypes, ","),
		strings.Join(releaseKinds, ","),
		strings.ToUpper(strings.TrimSpace(query.Region)),
		strings.ToLower(strings.TrimSpace(query.Locale)),
		query.Window.Start.UTC().Format(time.RFC3339Nano),
		query.Window.End.UTC().Format(time.RFC3339Nano),
		strconv.Itoa(query.MaxItems),
	}, "|")
}

func normalizedMediaTypes(values []MediaType) []MediaType {
	if len(values) == 0 {
		values = []MediaType{MediaTypeAnime, MediaTypeShow, MediaTypeMovie}
	}
	seen := make(map[MediaType]struct{}, len(values))
	result := make([]MediaType, 0, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}

func normalizedReleaseKinds(values []ReleaseKind) []ReleaseKind {
	if len(values) == 0 {
		values = []ReleaseKind{ReleaseKindAiring, ReleaseKindDigital, ReleaseKindPhysical, ReleaseKindTheatrical}
	}
	seen := make(map[ReleaseKind]struct{}, len(values))
	result := make([]ReleaseKind, 0, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}

func cloneCandidates(values []Candidate) []Candidate {
	if values == nil {
		return nil
	}
	cloned := make([]Candidate, len(values))
	copy(cloned, values)
	for index := range cloned {
		cloned[index].Genres = append([]string(nil), cloned[index].Genres...)
	}
	return cloned
}

func cloneProfile(profile Profile) Profile {
	profile.SeenMediaKeys = append([]string(nil), profile.SeenMediaKeys...)
	if profile.GenreWeights != nil {
		weights := make(map[string]float64, len(profile.GenreWeights))
		for genre, weight := range profile.GenreWeights {
			weights[genre] = weight
		}
		profile.GenreWeights = weights
	}
	return profile
}
