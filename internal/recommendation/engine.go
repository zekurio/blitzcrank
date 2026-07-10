package recommendation

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
)

const (
	defaultMaxItems = 10
	maximumMaxItems = 100
)

type Engine struct {
	catalogs []Catalog
	profiles ProfileSource
	ranker   Ranker
}

func NewEngine(catalogs []Catalog, profiles ProfileSource, ranker Ranker) *Engine {
	if ranker == nil {
		ranker = GenrePopularityRanker{}
	}
	return &Engine{
		catalogs: append([]Catalog(nil), catalogs...),
		profiles: profiles,
		ranker:   ranker,
	}
}

// Recommend returns all usable partial results. Upstream failures are reported
// through Result.Warnings; invalid queries and caller cancellation are returned
// as errors because no complete recommendation decision can be made.
func (e *Engine) Recommend(ctx context.Context, query Query) (Result, error) {
	query, err := normalizeQuery(query)
	if err != nil {
		return Result{}, err
	}

	var result Result
	var profile Profile
	if e.profiles != nil && strings.TrimSpace(query.SubjectID) != "" {
		profile, err = e.profiles.Profile(ctx, query.SubjectID)
		if err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return Result{}, ctxErr
			}
			result.Warnings = append(result.Warnings, Warning{
				Source:  "profile",
				Message: "profile could not be loaded: " + err.Error(),
			})
			profile = Profile{}
		}
	}

	catalogResults := e.discover(ctx, query)
	if ctxErr := ctx.Err(); ctxErr != nil {
		return Result{}, ctxErr
	}

	seen := normalizedKeySet(profile.SeenMediaKeys)
	merged := make(map[string]Candidate)
	for _, catalogResult := range catalogResults {
		if catalogResult.err != nil {
			result.Warnings = append(result.Warnings, Warning{
				Source:  catalogResult.name,
				Message: "catalog query was incomplete: " + catalogResult.err.Error(),
			})
		}

		invalid := 0
		for _, candidate := range catalogResult.items {
			candidate = normalizeCandidate(candidate, catalogResult.name)
			if !validCandidate(candidate) {
				invalid++
				continue
			}
			if _, ok := seen[normalizeKey(candidate.MediaKey)]; ok {
				continue
			}
			if !queryMatchesCandidate(query, candidate) {
				continue
			}

			key := normalizeKey(candidate.EventKey)
			if existing, ok := merged[key]; ok {
				merged[key] = mergeCandidate(existing, candidate)
				continue
			}
			merged[key] = candidate
		}
		if invalid > 0 {
			result.Warnings = append(result.Warnings, Warning{
				Source:  catalogResult.name,
				Message: fmt.Sprintf("discarded %d invalid candidate(s)", invalid),
			})
		}
	}

	candidates := make([]Candidate, 0, len(merged))
	for _, candidate := range merged {
		candidates = append(candidates, candidate)
	}
	result.Items = e.rankAndSelect(query, profile, candidates)
	return result, nil
}

type catalogDiscovery struct {
	index int
	name  string
	items []Candidate
	err   error
}

func (e *Engine) discover(ctx context.Context, query Query) []catalogDiscovery {
	results := make([]catalogDiscovery, len(e.catalogs))
	var wg sync.WaitGroup
	for index, catalog := range e.catalogs {
		name := fmt.Sprintf("catalog_%d", index+1)
		if catalog != nil && strings.TrimSpace(catalog.Name()) != "" {
			name = strings.TrimSpace(catalog.Name())
		}
		results[index] = catalogDiscovery{index: index, name: name}
		if catalog == nil {
			results[index].err = errors.New("catalog is nil")
			continue
		}

		wg.Add(1)
		go func(index int, catalog Catalog) {
			defer wg.Done()
			items, err := catalog.Discover(ctx, query)
			results[index].items = items
			results[index].err = err
		}(index, catalog)
	}
	wg.Wait()
	return results
}

type scoredCandidate struct {
	candidate Candidate
	score     float64
}

type candidateGroup struct {
	mediaType   MediaType
	releaseKind ReleaseKind
}

func (e *Engine) rankAndSelect(query Query, profile Profile, candidates []Candidate) []Candidate {
	if len(candidates) == 0 {
		return nil
	}
	weights := combinedGenreWeights(profile.GenreWeights, query.Interests)
	input := RankInput{Query: query, Profile: profile, GenreWeights: weights}
	groups := make(map[candidateGroup][]scoredCandidate)
	for _, candidate := range candidates {
		score := e.ranker.Score(candidate, input)
		if math.IsNaN(score) {
			score = math.Inf(-1)
		}
		key := candidateGroup{mediaType: candidate.MediaType, releaseKind: candidate.ReleaseKind}
		groups[key] = append(groups[key], scoredCandidate{candidate: candidate, score: score})
	}

	keys := make([]candidateGroup, 0, len(groups))
	for key := range groups {
		items := groups[key]
		sort.SliceStable(items, func(i, j int) bool {
			if items[i].score != items[j].score {
				return items[i].score > items[j].score
			}
			if !items[i].candidate.ReleaseAt.Equal(items[j].candidate.ReleaseAt) {
				return items[i].candidate.ReleaseAt.Before(items[j].candidate.ReleaseAt)
			}
			if items[i].candidate.Popularity != items[j].candidate.Popularity {
				return items[i].candidate.Popularity > items[j].candidate.Popularity
			}
			return items[i].candidate.EventKey < items[j].candidate.EventKey
		})
		groups[key] = items
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		left := groups[keys[i]][0]
		right := groups[keys[j]][0]
		if left.score != right.score {
			return left.score > right.score
		}
		if keys[i].mediaType != keys[j].mediaType {
			return keys[i].mediaType < keys[j].mediaType
		}
		return keys[i].releaseKind < keys[j].releaseKind
	})

	limit := min(query.MaxItems, len(candidates))
	selected := make([]Candidate, 0, limit)
	positions := make(map[candidateGroup]int, len(keys))
	for len(selected) < limit {
		progressed := false
		for _, key := range keys {
			position := positions[key]
			items := groups[key]
			if position >= len(items) {
				continue
			}
			selected = append(selected, items[position].candidate)
			positions[key] = position + 1
			progressed = true
			if len(selected) == limit {
				break
			}
		}
		if !progressed {
			break
		}
	}
	return selected
}

// GenrePopularityRanker favors popular candidates and adds every matching
// case-insensitive genre weight. Popularity uses a logarithm because upstream
// catalogs expose different long-tailed scales.
type GenrePopularityRanker struct{}

func (GenrePopularityRanker) Score(candidate Candidate, input RankInput) float64 {
	popularity := max(candidate.Popularity, 0)
	score := math.Log1p(popularity)
	seenGenres := make(map[string]struct{}, len(candidate.Genres))
	for _, genre := range candidate.Genres {
		key := normalizeGenre(genre)
		if key == "" {
			continue
		}
		if _, ok := seenGenres[key]; ok {
			continue
		}
		seenGenres[key] = struct{}{}
		score += input.GenreWeights[key]
	}
	return score
}

func normalizeQuery(query Query) (Query, error) {
	if query.Window.Start.IsZero() || query.Window.End.IsZero() {
		return Query{}, errors.New("recommendation window start and end are required")
	}
	query.Window.Start = query.Window.Start.UTC()
	query.Window.End = query.Window.End.UTC()
	if !query.Window.Start.Before(query.Window.End) {
		return Query{}, errors.New("recommendation window end must be after start")
	}
	if query.MaxItems < 0 {
		return Query{}, errors.New("max items must not be negative")
	}
	if query.MaxItems == 0 {
		query.MaxItems = defaultMaxItems
	}
	if query.MaxItems > maximumMaxItems {
		return Query{}, fmt.Errorf("max items must not exceed %d", maximumMaxItems)
	}
	for _, mediaType := range query.MediaTypes {
		if !validMediaType(mediaType) {
			return Query{}, fmt.Errorf("unsupported media type %q", mediaType)
		}
	}
	for _, releaseKind := range query.ReleaseKinds {
		if !validReleaseKind(releaseKind) {
			return Query{}, fmt.Errorf("unsupported release kind %q", releaseKind)
		}
	}
	for genre, weight := range query.Interests {
		if strings.TrimSpace(genre) == "" || math.IsNaN(weight) || math.IsInf(weight, 0) {
			return Query{}, fmt.Errorf("invalid interest weight for genre %q", genre)
		}
	}
	query.Region = strings.ToUpper(strings.TrimSpace(query.Region))
	query.Locale = strings.TrimSpace(query.Locale)
	query.SubjectID = strings.TrimSpace(query.SubjectID)
	return query, nil
}

func normalizeCandidate(candidate Candidate, fallbackSource string) Candidate {
	candidate.MediaKey = strings.TrimSpace(candidate.MediaKey)
	candidate.EventKey = strings.TrimSpace(candidate.EventKey)
	candidate.Title = strings.TrimSpace(candidate.Title)
	candidate.Overview = strings.TrimSpace(candidate.Overview)
	candidate.URL = strings.TrimSpace(candidate.URL)
	candidate.Poster = strings.TrimSpace(candidate.Poster)
	candidate.Source = strings.TrimSpace(candidate.Source)
	if candidate.Source == "" {
		candidate.Source = fallbackSource
	}
	if !candidate.ReleaseAt.IsZero() {
		candidate.ReleaseAt = candidate.ReleaseAt.UTC()
	}
	candidate.Genres = mergeGenres(nil, candidate.Genres)
	return candidate
}

func validCandidate(candidate Candidate) bool {
	return candidate.MediaKey != "" &&
		candidate.EventKey != "" &&
		candidate.Title != "" &&
		candidate.Source != "" &&
		!candidate.ReleaseAt.IsZero() &&
		validMediaType(candidate.MediaType) &&
		validReleaseKind(candidate.ReleaseKind) &&
		!math.IsNaN(candidate.Popularity) &&
		!math.IsInf(candidate.Popularity, 0)
}

func queryMatchesCandidate(query Query, candidate Candidate) bool {
	if !containsMediaType(query.MediaTypes, candidate.MediaType) {
		return false
	}
	if !containsReleaseKind(query.ReleaseKinds, candidate.ReleaseKind) {
		return false
	}
	return !candidate.ReleaseAt.Before(query.Window.Start) && candidate.ReleaseAt.Before(query.Window.End)
}

func mergeCandidate(existing, incoming Candidate) Candidate {
	if existing.Overview == "" {
		existing.Overview = incoming.Overview
	}
	if existing.URL == "" {
		existing.URL = incoming.URL
	}
	if existing.Poster == "" {
		existing.Poster = incoming.Poster
	}
	if incoming.Popularity > existing.Popularity {
		existing.Popularity = incoming.Popularity
	}
	existing.Genres = mergeGenres(existing.Genres, incoming.Genres)
	return existing
}

func mergeGenres(left, right []string) []string {
	byKey := make(map[string]string, len(left)+len(right))
	for _, genre := range append(append([]string(nil), left...), right...) {
		genre = strings.TrimSpace(genre)
		key := normalizeGenre(genre)
		if key == "" {
			continue
		}
		if _, ok := byKey[key]; !ok {
			byKey[key] = genre
		}
	}
	genres := make([]string, 0, len(byKey))
	for _, genre := range byKey {
		genres = append(genres, genre)
	}
	sort.Slice(genres, func(i, j int) bool {
		return normalizeGenre(genres[i]) < normalizeGenre(genres[j])
	})
	return genres
}

func combinedGenreWeights(profile, query map[string]float64) map[string]float64 {
	weights := make(map[string]float64, len(profile)+len(query))
	for genre, weight := range profile {
		if key := normalizeGenre(genre); key != "" && !math.IsNaN(weight) && !math.IsInf(weight, 0) {
			weights[key] += weight
		}
	}
	for genre, weight := range query {
		if key := normalizeGenre(genre); key != "" {
			weights[key] += weight
		}
	}
	return weights
}

func normalizeGenre(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.NewReplacer("_", " ", "–", "-", "—", "-").Replace(value)
	value = strings.Join(strings.Fields(value), " ")
	switch value {
	case "sci fi", "sci-fi", "science fiction", "science-fiction":
		return "sci-fi"
	case "abenteuer":
		return "adventure"
	case "komödie", "komoedie":
		return "comedy"
	case "krimi":
		return "crime"
	case "dokumentation", "dokumentarfilm":
		return "documentary"
	case "familie":
		return "family"
	case "geschichte":
		return "history"
	case "musik":
		return "music"
	case "romantik", "liebesfilm":
		return "romance"
	case "krieg":
		return "war"
	case "übernatürlich", "uebernatuerlich":
		return "supernatural"
	case "alltagsleben":
		return "slice of life"
	default:
		return value
	}
}

func normalizedKeySet(values []string) map[string]struct{} {
	set := make(map[string]struct{}, len(values))
	for _, value := range values {
		if key := normalizeKey(value); key != "" {
			set[key] = struct{}{}
		}
	}
	return set
}

func normalizeKey(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func containsMediaType(filters []MediaType, candidate MediaType) bool {
	if len(filters) == 0 {
		return true
	}
	for _, filter := range filters {
		if filter == candidate {
			return true
		}
	}
	return false
}

func containsReleaseKind(filters []ReleaseKind, candidate ReleaseKind) bool {
	if len(filters) == 0 {
		return true
	}
	for _, filter := range filters {
		if filter == candidate {
			return true
		}
	}
	return false
}

func validMediaType(value MediaType) bool {
	switch value {
	case MediaTypeAnime, MediaTypeShow, MediaTypeMovie:
		return true
	default:
		return false
	}
}

func validReleaseKind(value ReleaseKind) bool {
	switch value {
	case ReleaseKindAiring, ReleaseKindDigital, ReleaseKindPhysical, ReleaseKindTheatrical:
		return true
	default:
		return false
	}
}
