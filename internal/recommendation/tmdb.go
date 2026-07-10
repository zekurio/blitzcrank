package recommendation

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	defaultTMDBBaseURL   = "https://api.themoviedb.org"
	defaultTMDBImageBase = "https://image.tmdb.org/t/p/w500"
	maximumTMDBPages     = 20
)

type TMDBCatalogOptions struct {
	BaseURL          string
	BearerToken      string
	HTTPClient       *http.Client
	MaxResponseBytes int64
}

type TMDBCatalog struct {
	baseURL          string
	bearerToken      string
	httpClient       *http.Client
	maxResponseBytes int64
}

func NewTMDBCatalog(options TMDBCatalogOptions) (*TMDBCatalog, error) {
	baseURL, err := catalogBaseURL(options.BaseURL, defaultTMDBBaseURL)
	if err != nil {
		return nil, fmt.Errorf("configure TMDB catalog: %w", err)
	}
	token := strings.TrimSpace(options.BearerToken)
	if token == "" {
		return nil, errors.New("configure TMDB catalog: bearer token is required")
	}
	return &TMDBCatalog{
		baseURL:          baseURL,
		bearerToken:      token,
		httpClient:       catalogHTTPClient(options.HTTPClient),
		maxResponseBytes: responseLimit(options.MaxResponseBytes),
	}, nil
}

func (c *TMDBCatalog) Name() string {
	return "tmdb"
}

func (c *TMDBCatalog) Discover(ctx context.Context, query Query) ([]Candidate, error) {
	query, err := normalizeQuery(query)
	if err != nil {
		return nil, err
	}

	var candidates []Candidate
	var queryErrors []error
	if containsMediaType(query.MediaTypes, MediaTypeMovie) {
		movieKinds := []struct {
			kind         ReleaseKind
			releaseTypes string
		}{
			{kind: ReleaseKindDigital, releaseTypes: "4"},
			{kind: ReleaseKindPhysical, releaseTypes: "5"},
			{kind: ReleaseKindTheatrical, releaseTypes: "3|2"},
		}
		if query.Region == "" {
			for _, movieKind := range movieKinds {
				if containsReleaseKind(query.ReleaseKinds, movieKind.kind) {
					queryErrors = append(queryErrors, errors.New("tmdb movie discovery requires a release region"))
					break
				}
			}
		} else {
			for _, movieKind := range movieKinds {
				if !containsReleaseKind(query.ReleaseKinds, movieKind.kind) {
					continue
				}
				items, discoverErr := c.discoverMovies(ctx, query, movieKind.kind, movieKind.releaseTypes)
				candidates = append(candidates, items...)
				if discoverErr != nil {
					queryErrors = append(queryErrors, discoverErr)
				}
			}
		}
	}

	if containsMediaType(query.MediaTypes, MediaTypeShow) && containsReleaseKind(query.ReleaseKinds, ReleaseKindAiring) {
		items, discoverErr := c.discoverShows(ctx, query)
		candidates = append(candidates, items...)
		if discoverErr != nil {
			queryErrors = append(queryErrors, discoverErr)
		}
	}
	sortCatalogCandidates(candidates)
	return candidates, errors.Join(queryErrors...)
}

type tmdbPage[T any] struct {
	Page       int `json:"page"`
	Results    []T `json:"results"`
	TotalPages int `json:"total_pages"`
}

type tmdbMovie struct {
	ID            int64   `json:"id"`
	Title         string  `json:"title"`
	OriginalTitle string  `json:"original_title"`
	Overview      string  `json:"overview"`
	PosterPath    string  `json:"poster_path"`
	ReleaseDate   string  `json:"release_date"`
	GenreIDs      []int   `json:"genre_ids"`
	Popularity    float64 `json:"popularity"`
}

type tmdbShow struct {
	ID           int64   `json:"id"`
	Name         string  `json:"name"`
	OriginalName string  `json:"original_name"`
	Overview     string  `json:"overview"`
	PosterPath   string  `json:"poster_path"`
	FirstAirDate string  `json:"first_air_date"`
	GenreIDs     []int   `json:"genre_ids"`
	Popularity   float64 `json:"popularity"`
}

func (c *TMDBCatalog) discoverMovies(ctx context.Context, query Query, kind ReleaseKind, releaseTypes string) ([]Candidate, error) {
	limit := query.MaxItems
	seen := make(map[string]struct{}, limit)
	items := make([]Candidate, 0, limit)
	for page := 1; page <= maximumTMDBPages; page++ {
		values := c.commonQuery(query, page)
		values.Set("include_video", "false")
		values.Set("region", query.Region)
		values.Set("release_date.gte", query.Window.Start.Format(time.DateOnly))
		values.Set("release_date.lte", inclusiveWindowEnd(query.Window).Format(time.DateOnly))
		values.Set("with_release_type", releaseTypes)

		var response tmdbPage[tmdbMovie]
		if err := c.get(ctx, "/3/discover/movie", values, &response); err != nil {
			return items, fmt.Errorf("discover TMDB %s movies: %w", kind, err)
		}
		for _, movie := range response.Results {
			candidate, ok := tmdbMovieCandidate(movie, kind, query.Region, query.Window)
			if !ok {
				continue
			}
			if _, ok := seen[candidate.EventKey]; ok {
				continue
			}
			seen[candidate.EventKey] = struct{}{}
			items = append(items, candidate)
			if len(items) == limit {
				return items, nil
			}
		}
		if response.TotalPages <= page || response.TotalPages <= 0 {
			return items, nil
		}
	}
	return items, fmt.Errorf("tmdb %s movie discovery exceeded the %d-page safety limit", kind, maximumTMDBPages)
}

func (c *TMDBCatalog) discoverShows(ctx context.Context, query Query) ([]Candidate, error) {
	limit := query.MaxItems
	seen := make(map[string]struct{}, limit)
	items := make([]Candidate, 0, limit)
	for page := 1; page <= maximumTMDBPages; page++ {
		values := c.commonQuery(query, page)
		values.Set("include_null_first_air_dates", "false")
		values.Set("first_air_date.gte", query.Window.Start.Format(time.DateOnly))
		values.Set("first_air_date.lte", inclusiveWindowEnd(query.Window).Format(time.DateOnly))

		var response tmdbPage[tmdbShow]
		if err := c.get(ctx, "/3/discover/tv", values, &response); err != nil {
			return items, fmt.Errorf("discover TMDB shows: %w", err)
		}
		for _, show := range response.Results {
			candidate, ok := tmdbShowCandidate(show, query.Window)
			if !ok {
				continue
			}
			if _, ok := seen[candidate.EventKey]; ok {
				continue
			}
			seen[candidate.EventKey] = struct{}{}
			items = append(items, candidate)
			if len(items) == limit {
				return items, nil
			}
		}
		if response.TotalPages <= page || response.TotalPages <= 0 {
			return items, nil
		}
	}
	return items, fmt.Errorf("tmdb show discovery exceeded the %d-page safety limit", maximumTMDBPages)
}

func (c *TMDBCatalog) commonQuery(query Query, page int) url.Values {
	values := url.Values{
		"include_adult": {"false"},
		"page":          {strconv.Itoa(page)},
		"sort_by":       {"popularity.desc"},
	}
	if query.Locale != "" {
		values.Set("language", query.Locale)
	}
	return values
}

func (c *TMDBCatalog) get(ctx context.Context, path string, values url.Values, target any) error {
	targetURL := c.baseURL + path + "?" + values.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return fmt.Errorf("create TMDB request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+c.bearerToken)
	request.Header.Set("Accept", "application/json")
	response, err := c.httpClient.Do(request)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		return fmt.Errorf("perform TMDB request: %w", err)
	}
	return decodeCatalogResponse(response, c.maxResponseBytes, "TMDB", target)
}

func tmdbMovieCandidate(movie tmdbMovie, kind ReleaseKind, region string, window Window) (Candidate, bool) {
	releaseAt, err := time.Parse(time.DateOnly, strings.TrimSpace(movie.ReleaseDate))
	if err != nil || releaseAt.Before(window.Start) || !releaseAt.Before(window.End) || movie.ID <= 0 {
		return Candidate{}, false
	}
	title := strings.TrimSpace(movie.Title)
	if title == "" {
		title = strings.TrimSpace(movie.OriginalTitle)
	}
	if title == "" {
		return Candidate{}, false
	}
	mediaKey := "tmdb:movie:" + strconv.FormatInt(movie.ID, 10)
	return Candidate{
		MediaKey:    mediaKey,
		EventKey:    releaseEventKey(mediaKey, kind, region, releaseAt),
		MediaType:   MediaTypeMovie,
		ReleaseKind: kind,
		Title:       title,
		Overview:    strings.TrimSpace(movie.Overview),
		URL:         "https://www.themoviedb.org/movie/" + strconv.FormatInt(movie.ID, 10),
		Poster:      tmdbPosterURL(movie.PosterPath),
		ReleaseAt:   releaseAt.UTC(),
		Genres:      tmdbGenres(MediaTypeMovie, movie.GenreIDs),
		Popularity:  movie.Popularity,
		Source:      "tmdb",
	}, true
}

func tmdbShowCandidate(show tmdbShow, window Window) (Candidate, bool) {
	releaseAt, err := time.Parse(time.DateOnly, strings.TrimSpace(show.FirstAirDate))
	if err != nil || releaseAt.Before(window.Start) || !releaseAt.Before(window.End) || show.ID <= 0 {
		return Candidate{}, false
	}
	title := strings.TrimSpace(show.Name)
	if title == "" {
		title = strings.TrimSpace(show.OriginalName)
	}
	if title == "" {
		return Candidate{}, false
	}
	mediaKey := "tmdb:tv:" + strconv.FormatInt(show.ID, 10)
	return Candidate{
		MediaKey:    mediaKey,
		EventKey:    releaseEventKey(mediaKey, ReleaseKindAiring, "global", releaseAt),
		MediaType:   MediaTypeShow,
		ReleaseKind: ReleaseKindAiring,
		Title:       title,
		Overview:    strings.TrimSpace(show.Overview),
		URL:         "https://www.themoviedb.org/tv/" + strconv.FormatInt(show.ID, 10),
		Poster:      tmdbPosterURL(show.PosterPath),
		ReleaseAt:   releaseAt.UTC(),
		Genres:      tmdbGenres(MediaTypeShow, show.GenreIDs),
		Popularity:  show.Popularity,
		Source:      "tmdb",
	}, true
}

func inclusiveWindowEnd(window Window) time.Time {
	return window.End.Add(-time.Nanosecond)
}

func releaseEventKey(mediaKey string, kind ReleaseKind, scope string, releaseAt time.Time) string {
	scope = strings.TrimSpace(scope)
	if scope == "" {
		scope = "global"
	}
	return fmt.Sprintf("%s:%s:%s:%s", mediaKey, kind, scope, releaseAt.UTC().Format(time.DateOnly))
}

func tmdbPosterURL(posterPath string) string {
	posterPath = strings.TrimSpace(posterPath)
	if posterPath == "" {
		return ""
	}
	return defaultTMDBImageBase + "/" + strings.TrimLeft(posterPath, "/")
}

func sortCatalogCandidates(candidates []Candidate) {
	sort.SliceStable(candidates, func(i, j int) bool {
		if !candidates[i].ReleaseAt.Equal(candidates[j].ReleaseAt) {
			return candidates[i].ReleaseAt.Before(candidates[j].ReleaseAt)
		}
		if candidates[i].Popularity != candidates[j].Popularity {
			return candidates[i].Popularity > candidates[j].Popularity
		}
		return candidates[i].EventKey < candidates[j].EventKey
	})
}

func tmdbGenres(mediaType MediaType, ids []int) []string {
	var genres []string
	for _, id := range ids {
		if mediaType == MediaTypeMovie {
			genres = append(genres, tmdbMovieGenres[id]...)
		} else {
			genres = append(genres, tmdbShowGenres[id]...)
		}
	}
	return mergeGenres(nil, genres)
}

var tmdbMovieGenres = map[int][]string{
	12:    {"Adventure"},
	14:    {"Fantasy"},
	16:    {"Animation"},
	18:    {"Drama"},
	27:    {"Horror"},
	28:    {"Action"},
	35:    {"Comedy"},
	36:    {"History"},
	37:    {"Western"},
	53:    {"Thriller"},
	80:    {"Crime"},
	99:    {"Documentary"},
	878:   {"Sci-Fi"},
	9648:  {"Mystery"},
	10402: {"Music"},
	10749: {"Romance"},
	10751: {"Family"},
	10752: {"War"},
	10770: {"TV Movie"},
}

var tmdbShowGenres = map[int][]string{
	16:    {"Animation"},
	18:    {"Drama"},
	35:    {"Comedy"},
	37:    {"Western"},
	80:    {"Crime"},
	99:    {"Documentary"},
	9648:  {"Mystery"},
	10751: {"Family"},
	10759: {"Action", "Adventure"},
	10762: {"Kids"},
	10763: {"News"},
	10764: {"Reality"},
	10765: {"Sci-Fi", "Fantasy"},
	10766: {"Soap"},
	10767: {"Talk"},
	10768: {"War", "Politics"},
}
