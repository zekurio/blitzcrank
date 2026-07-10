package recommendation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	defaultAniListEndpoint = "https://graphql.anilist.co"
	maximumAniListPages    = 10
)

type AniListCatalogOptions struct {
	Endpoint         string
	HTTPClient       *http.Client
	MaxResponseBytes int64
}

type AniListCatalog struct {
	endpoint         string
	httpClient       *http.Client
	maxResponseBytes int64
}

func NewAniListCatalog(options AniListCatalogOptions) (*AniListCatalog, error) {
	endpoint, err := catalogBaseURL(options.Endpoint, defaultAniListEndpoint)
	if err != nil {
		return nil, fmt.Errorf("configure AniList catalog: %w", err)
	}
	return &AniListCatalog{
		endpoint:         endpoint,
		httpClient:       catalogHTTPClient(options.HTTPClient),
		maxResponseBytes: responseLimit(options.MaxResponseBytes),
	}, nil
}

func (c *AniListCatalog) Name() string {
	return "anilist"
}

func (c *AniListCatalog) Discover(ctx context.Context, query Query) ([]Candidate, error) {
	query, err := normalizeQuery(query)
	if err != nil {
		return nil, err
	}
	if !containsMediaType(query.MediaTypes, MediaTypeAnime) || !containsReleaseKind(query.ReleaseKinds, ReleaseKindAiring) {
		return nil, nil
	}

	limit := query.MaxItems
	perPage := min(limit, 50)
	seen := make(map[string]struct{}, limit)
	items := make([]Candidate, 0, limit)
	for page := 1; page <= maximumAniListPages; page++ {
		variables := map[string]any{
			"page":             page,
			"perPage":          perPage,
			"startDateGreater": fuzzyDateInt(query.Window.Start.AddDate(0, 0, -1)),
			"startDateLesser":  fuzzyDateInt(exclusiveDateUpperBound(query.Window.End)),
		}
		response, requestErr := c.post(ctx, variables)
		for _, media := range response.Data.Page.Media {
			candidate, ok := aniListCandidate(media, query.Locale, query.Window)
			if !ok {
				continue
			}
			if _, ok := seen[candidate.EventKey]; ok {
				continue
			}
			seen[candidate.EventKey] = struct{}{}
			items = append(items, candidate)
			if len(items) == limit {
				sortCatalogCandidates(items)
				return items, requestErr
			}
		}
		if requestErr != nil {
			sortCatalogCandidates(items)
			return items, fmt.Errorf("discover AniList anime: %w", requestErr)
		}
		if !response.Data.Page.PageInfo.HasNextPage {
			sortCatalogCandidates(items)
			return items, nil
		}
	}
	sortCatalogCandidates(items)
	return items, fmt.Errorf("anilist anime discovery exceeded the %d-page safety limit", maximumAniListPages)
}

const aniListDiscoveryQuery = `
query ($page: Int!, $perPage: Int!, $startDateGreater: FuzzyDateInt, $startDateLesser: FuzzyDateInt) {
  Page(page: $page, perPage: $perPage) {
    pageInfo {
      hasNextPage
    }
    media(
      type: ANIME
      isAdult: false
      startDate_greater: $startDateGreater
      startDate_lesser: $startDateLesser
      sort: [POPULARITY_DESC]
    ) {
      id
      title {
        userPreferred
        english
        romaji
        native
      }
      description(asHtml: false)
      siteUrl
      coverImage {
        extraLarge
        large
      }
      startDate {
        year
        month
        day
      }
      genres
      popularity
    }
  }
}`

type aniListResponse struct {
	Data struct {
		Page struct {
			PageInfo struct {
				HasNextPage bool `json:"hasNextPage"`
			} `json:"pageInfo"`
			Media []aniListMedia `json:"media"`
		} `json:"Page"`
	} `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

type aniListMedia struct {
	ID    int64 `json:"id"`
	Title struct {
		UserPreferred string `json:"userPreferred"`
		English       string `json:"english"`
		Romaji        string `json:"romaji"`
		Native        string `json:"native"`
	} `json:"title"`
	Description string `json:"description"`
	SiteURL     string `json:"siteUrl"`
	CoverImage  struct {
		ExtraLarge string `json:"extraLarge"`
		Large      string `json:"large"`
	} `json:"coverImage"`
	StartDate struct {
		Year  int `json:"year"`
		Month int `json:"month"`
		Day   int `json:"day"`
	} `json:"startDate"`
	Genres     []string `json:"genres"`
	Popularity float64  `json:"popularity"`
}

func (c *AniListCatalog) post(ctx context.Context, variables map[string]any) (aniListResponse, error) {
	body, err := json.Marshal(map[string]any{
		"query":     aniListDiscoveryQuery,
		"variables": variables,
	})
	if err != nil {
		return aniListResponse{}, fmt.Errorf("encode AniList request: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return aniListResponse{}, fmt.Errorf("create AniList request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	response, err := c.httpClient.Do(request)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return aniListResponse{}, ctxErr
		}
		return aniListResponse{}, fmt.Errorf("perform AniList request: %w", err)
	}
	var decoded aniListResponse
	if err := decodeCatalogResponse(response, c.maxResponseBytes, "AniList", &decoded); err != nil {
		return aniListResponse{}, err
	}
	if len(decoded.Errors) > 0 {
		return decoded, errors.New("anilist GraphQL returned errors")
	}
	return decoded, nil
}

func aniListCandidate(media aniListMedia, locale string, window Window) (Candidate, bool) {
	releaseAt, ok := exactAniListDate(media.StartDate.Year, media.StartDate.Month, media.StartDate.Day)
	if !ok || releaseAt.Before(window.Start) || !releaseAt.Before(window.End) || media.ID <= 0 {
		return Candidate{}, false
	}
	title := aniListTitle(media, locale)
	if title == "" {
		return Candidate{}, false
	}
	mediaKey := "anilist:anime:" + strconv.FormatInt(media.ID, 10)
	siteURL := strings.TrimSpace(media.SiteURL)
	if siteURL == "" {
		siteURL = "https://anilist.co/anime/" + strconv.FormatInt(media.ID, 10)
	}
	poster := strings.TrimSpace(media.CoverImage.ExtraLarge)
	if poster == "" {
		poster = strings.TrimSpace(media.CoverImage.Large)
	}
	return Candidate{
		MediaKey:    mediaKey,
		EventKey:    releaseEventKey(mediaKey, ReleaseKindAiring, "global", releaseAt),
		MediaType:   MediaTypeAnime,
		ReleaseKind: ReleaseKindAiring,
		Title:       title,
		Overview:    strings.TrimSpace(media.Description),
		URL:         siteURL,
		Poster:      poster,
		ReleaseAt:   releaseAt,
		Genres:      mergeGenres(nil, media.Genres),
		Popularity:  media.Popularity,
		Source:      "anilist",
	}, true
}

func aniListTitle(media aniListMedia, locale string) string {
	language := strings.ToLower(strings.TrimSpace(locale))
	var choices []string
	switch {
	case strings.HasPrefix(language, "ja"):
		choices = []string{media.Title.Native, media.Title.UserPreferred, media.Title.Romaji, media.Title.English}
	case strings.HasPrefix(language, "en"):
		choices = []string{media.Title.English, media.Title.UserPreferred, media.Title.Romaji, media.Title.Native}
	default:
		choices = []string{media.Title.UserPreferred, media.Title.English, media.Title.Romaji, media.Title.Native}
	}
	for _, choice := range choices {
		if choice = strings.TrimSpace(choice); choice != "" {
			return choice
		}
	}
	return ""
}

func exactAniListDate(year, month, day int) (time.Time, bool) {
	if year < 1 || month < 1 || month > 12 || day < 1 || day > 31 {
		return time.Time{}, false
	}
	date := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	if date.Year() != year || int(date.Month()) != month || date.Day() != day {
		return time.Time{}, false
	}
	return date, true
}

func fuzzyDateInt(date time.Time) int {
	value, _ := strconv.Atoi(date.UTC().Format("20060102"))
	return value
}

func exclusiveDateUpperBound(end time.Time) time.Time {
	end = end.UTC()
	midnight := time.Date(end.Year(), end.Month(), end.Day(), 0, 0, 0, 0, time.UTC)
	if end.Equal(midnight) {
		return midnight
	}
	return midnight.AddDate(0, 0, 1)
}
