package arrcalendar

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"sort"
	"strings"
	"time"

	"blitzcrank/internal/digest"
)

const maxResponseBytes = 4 << 20

type Client struct {
	sonarrURL, sonarrKey string
	radarrURL, radarrKey string
	http                 *http.Client
}

func New(sonarrURL, sonarrKey, radarrURL, radarrKey string, httpClient *http.Client) (*Client, error) {
	sonarr, err := normalizeBaseURL(sonarrURL)
	if err != nil {
		return nil, fmt.Errorf("validate Sonarr URL: %w", err)
	}
	radarr, err := normalizeBaseURL(radarrURL)
	if err != nil {
		return nil, fmt.Errorf("validate Radarr URL: %w", err)
	}
	if strings.TrimSpace(sonarrKey) == "" || strings.TrimSpace(radarrKey) == "" {
		return nil, errors.New("Sonarr and Radarr API keys are required")
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 20 * time.Second}
	}
	return &Client{sonarrURL: sonarr, sonarrKey: strings.TrimSpace(sonarrKey), radarrURL: radarr, radarrKey: strings.TrimSpace(radarrKey), http: httpClient}, nil
}

func normalizeBaseURL(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("must be an absolute HTTP(S) URL")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", errors.New("must use HTTP or HTTPS")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("must not contain credentials, a query, or a fragment")
	}
	return strings.TrimRight(parsed.String(), "/"), nil
}

func (c *Client) Fetch(ctx context.Context, query digest.CalendarQuery) (digest.CalendarResult, error) {
	if !query.End.After(query.Start) {
		return digest.CalendarResult{}, errors.New("calendar end must be after start")
	}
	var result digest.CalendarResult
	if slices.Contains(query.Topics, digest.TopicShows) {
		items, err := c.fetchSonarr(ctx, query.Start, query.End)
		if err != nil {
			if ctx.Err() != nil {
				return result, ctx.Err()
			}
			result.Warnings = append(result.Warnings, "Sonarr calendar unavailable")
		} else {
			result.Items = append(result.Items, items...)
		}
	}
	if slices.Contains(query.Topics, digest.TopicMovies) {
		items, err := c.fetchRadarr(ctx, query.Start, query.End)
		if err != nil {
			if ctx.Err() != nil {
				return result, ctx.Err()
			}
			result.Warnings = append(result.Warnings, "Radarr calendar unavailable")
		} else {
			result.Items = append(result.Items, items...)
		}
	}
	sort.SliceStable(result.Items, func(i, j int) bool {
		if !result.Items[i].OccursAt.Equal(result.Items[j].OccursAt) {
			return result.Items[i].OccursAt.Before(result.Items[j].OccursAt)
		}
		return result.Items[i].EventKey < result.Items[j].EventKey
	})
	if query.Limit > 0 && len(result.Items) > query.Limit {
		result.Items = result.Items[:query.Limit]
	}
	return result, nil
}

type sonarrEpisode struct {
	ID, TvdbID, SeasonNumber, EpisodeNumber int
	Title, Overview                         string
	AirDateUTC                              time.Time `json:"airDateUtc"`
	HasFile, Monitored                      bool
	Series                                  struct {
		Title     string
		Monitored bool
		TvdbID    int
	}
}

func (c *Client) fetchSonarr(ctx context.Context, start, end time.Time) ([]digest.Entry, error) {
	var episodes []sonarrEpisode
	if err := c.get(ctx, c.sonarrURL, c.sonarrKey, start, end, map[string]string{"includeSeries": "true", "includeEpisodeFile": "false"}, &episodes); err != nil {
		return nil, err
	}
	items := make([]digest.Entry, 0, len(episodes))
	for _, episode := range episodes {
		if !episode.Monitored || !episode.Series.Monitored || !inWindow(episode.AirDateUTC, start, end) {
			continue
		}
		id := episode.TvdbID
		if id == 0 {
			id = episode.ID
		}
		items = append(items, digest.Entry{
			EventKey: fmt.Sprintf("sonarr:episode:%d:%s", id, episode.AirDateUTC.UTC().Format(time.RFC3339)),
			Topic:    digest.TopicShows, Kind: digest.EntryKindEpisode, Title: episode.Series.Title,
			Subtitle: fmt.Sprintf("S%02dE%02d · %s", episode.SeasonNumber, episode.EpisodeNumber, episode.Title),
			Overview: episode.Overview, OccursAt: episode.AirDateUTC.UTC(), HasFile: episode.HasFile, Source: "Sonarr",
		})
	}
	return items, nil
}

type radarrMovie struct {
	ID                                         int
	TmdbID                                     int
	Title                                      string
	Overview                                   string
	Monitored                                  bool
	HasFile                                    bool
	InCinemas, DigitalRelease, PhysicalRelease *time.Time
}

func (c *Client) fetchRadarr(ctx context.Context, start, end time.Time) ([]digest.Entry, error) {
	var movies []radarrMovie
	if err := c.get(ctx, c.radarrURL, c.radarrKey, start, end, nil, &movies); err != nil {
		return nil, err
	}
	var items []digest.Entry
	for _, movie := range movies {
		if !movie.Monitored {
			continue
		}
		id := movie.TmdbID
		if id == 0 {
			id = movie.ID
		}
		for _, release := range []struct {
			kind digest.EntryKind
			at   *time.Time
		}{{digest.EntryKindCinema, movie.InCinemas}, {digest.EntryKindDigital, movie.DigitalRelease}, {digest.EntryKindPhysical, movie.PhysicalRelease}} {
			if release.at == nil || !inWindow(*release.at, start, end) {
				continue
			}
			items = append(items, digest.Entry{
				EventKey: fmt.Sprintf("radarr:movie:%d:%s:%s", id, release.kind, release.at.UTC().Format(time.RFC3339)),
				Topic:    digest.TopicMovies, Kind: release.kind, Title: movie.Title, Overview: movie.Overview,
				OccursAt: release.at.UTC(), HasFile: movie.HasFile, Source: "Radarr",
			})
		}
	}
	return items, nil
}

func (c *Client) get(ctx context.Context, baseURL, apiKey string, start, end time.Time, extra map[string]string, target any) error {
	values := url.Values{"start": {start.UTC().Format(time.RFC3339)}, "end": {end.UTC().Format(time.RFC3339)}, "unmonitored": {"false"}}
	for key, value := range extra {
		values.Set(key, value)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/api/v3/calendar?"+values.Encode(), nil)
	if err != nil {
		return fmt.Errorf("build calendar request: %w", err)
	}
	req.Header.Set("X-Api-Key", apiKey)
	req.Header.Set("Accept", "application/json")
	response, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("request calendar: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return fmt.Errorf("calendar returned HTTP %d", response.StatusCode)
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, maxResponseBytes))
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("decode calendar response: %w", err)
	}
	return nil
}

func inWindow(value, start, end time.Time) bool {
	return !value.Before(start) && value.Before(end)
}
