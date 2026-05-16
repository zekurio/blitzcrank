package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"blitzcrank/internal/config"
)

type Registry struct {
	cfg  config.Config
	http *http.Client
}

type toolDef struct {
	Name        string
	Description string
	Parameters  map[string]any
}

func NewRegistry(cfg config.Config) *Registry {
	return &Registry{
		cfg: cfg,
		http: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

func (r *Registry) OpenAITools() []any {
	defs := []toolDef{
		{
			Name:        "seerr_get_request",
			Description: "Fetch a Jellyseerr/Overseerr request by request_id.",
			Parameters:  objectSchema(map[string]any{"request_id": stringSchema("Jellyseerr request id")}, []string{"request_id"}),
		},
		{
			Name:        "seerr_get_issue",
			Description: "Fetch a Jellyseerr/Overseerr issue by issue_id.",
			Parameters:  objectSchema(map[string]any{"issue_id": stringSchema("Jellyseerr issue id")}, []string{"issue_id"}),
		},
		{
			Name:        "seerr_resolve_issue",
			Description: "Mark a Jellyseerr/Overseerr issue as resolved after the fix has been validated with tools.",
			Parameters:  objectSchema(map[string]any{"issue_id": stringSchema("Jellyseerr issue id")}, []string{"issue_id"}),
		},
		{
			Name:        "jellyfin_search_items",
			Description: "Search Jellyfin library items by name.",
			Parameters:  objectSchema(map[string]any{"query": stringSchema("Movie, series, episode, or person search text")}, []string{"query"}),
		},
		{
			Name:        "jellyfin_get_item",
			Description: "Fetch a Jellyfin item by item_id.",
			Parameters:  objectSchema(map[string]any{"item_id": stringSchema("Jellyfin item id")}, []string{"item_id"}),
		},
		{
			Name:        "jellyfin_get_item_media_info",
			Description: "Fetch concise Jellyfin media-source and stream metadata for one movie, episode, or video item, including available audio and subtitle tracks.",
			Parameters:  objectSchema(map[string]any{"item_id": stringSchema("Jellyfin item id")}, []string{"item_id"}),
		},
		{
			Name:        "jellyfin_get_child_media_info",
			Description: "Fetch concise Jellyfin media-source and stream metadata for video children under a series, season, folder, or collection item.",
			Parameters: objectSchema(map[string]any{
				"item_id": stringSchema("Parent Jellyfin item id"),
				"limit":   numberSchema("Maximum child video items to return, from 1 to 100"),
			}, []string{"item_id"}),
		},
		{
			Name:        "jellyfin_refresh_item",
			Description: "Refresh Jellyfin metadata for a known item id.",
			Parameters:  objectSchema(map[string]any{"item_id": stringSchema("Jellyfin item id")}, []string{"item_id"}),
		},
		{
			Name:        "sonarr_get_series_by_tvdb_id",
			Description: "Find a Sonarr series by TVDB id.",
			Parameters:  objectSchema(map[string]any{"tvdb_id": stringSchema("TVDB id")}, []string{"tvdb_id"}),
		},
		{
			Name:        "sonarr_get_queue",
			Description: "Read the current Sonarr queue.",
			Parameters:  objectSchema(map[string]any{}, nil),
		},
		{
			Name:        "sonarr_get_blocklist",
			Description: "Read recent Sonarr blocklist entries for failed or corrupt releases.",
			Parameters:  objectSchema(map[string]any{"page_size": numberSchema("Maximum entries to return")}, nil),
		},
		{
			Name:        "sonarr_delete_blocklist_item",
			Description: "Remove one confirmed Sonarr blocklist item by id so Sonarr can search/download another release.",
			Parameters:  objectSchema(map[string]any{"blocklist_id": stringSchema("Sonarr blocklist item id")}, []string{"blocklist_id"}),
		},
		{
			Name:        "sonarr_get_episodes_by_series_id",
			Description: "List Sonarr episodes for a known series id so a specific missing episode can be searched.",
			Parameters:  objectSchema(map[string]any{"series_id": stringSchema("Sonarr series id")}, []string{"series_id"}),
		},
		{
			Name:        "sonarr_get_episode_file",
			Description: "Fetch Sonarr episode-file metadata by episode_file_id, including quality, languages, and mediaInfo when Sonarr has it.",
			Parameters:  objectSchema(map[string]any{"episode_file_id": stringSchema("Sonarr episode file id")}, []string{"episode_file_id"}),
		},
		{
			Name:        "sonarr_get_episode_files_by_series_id",
			Description: "List Sonarr episode-file metadata for a known series, optionally narrowed to one season, including quality, languages, and mediaInfo when Sonarr has it.",
			Parameters: objectSchema(map[string]any{
				"series_id":     stringSchema("Sonarr series id"),
				"season_number": stringSchema("Optional season number to narrow the file list"),
			}, []string{"series_id"}),
		},
		{
			Name:        "sonarr_search_episode",
			Description: "Trigger a Sonarr search for a specific episode id.",
			Parameters:  objectSchema(map[string]any{"episode_id": stringSchema("Sonarr episode id")}, []string{"episode_id"}),
		},
		{
			Name:        "sonarr_search_season",
			Description: "Trigger a Sonarr search for one season of a known series.",
			Parameters: objectSchema(map[string]any{
				"series_id":     stringSchema("Sonarr series id"),
				"season_number": stringSchema("Season number to search"),
			}, []string{"series_id", "season_number"}),
		},
		{
			Name:        "sonarr_search_series",
			Description: "Trigger a Sonarr search for all monitored episodes of a known series.",
			Parameters:  objectSchema(map[string]any{"series_id": stringSchema("Sonarr series id")}, []string{"series_id"}),
		},
		{
			Name:        "sonarr_refresh_series",
			Description: "Trigger a Sonarr refresh/rescan command for a known series id.",
			Parameters:  objectSchema(map[string]any{"series_id": stringSchema("Sonarr series id")}, []string{"series_id"}),
		},
		{
			Name:        "sonarr_retry_queue_item",
			Description: "Retry/grab a known Sonarr queue item id.",
			Parameters:  objectSchema(map[string]any{"queue_id": stringSchema("Sonarr queue item id")}, []string{"queue_id"}),
		},
		{
			Name:        "radarr_get_movie_by_tmdb_id",
			Description: "Find a Radarr movie by TMDB id.",
			Parameters:  objectSchema(map[string]any{"tmdb_id": stringSchema("TMDB id")}, []string{"tmdb_id"}),
		},
		{
			Name:        "radarr_get_movie_by_id",
			Description: "Fetch a Radarr movie by movie_id, including movieFile metadata when Radarr has it.",
			Parameters:  objectSchema(map[string]any{"movie_id": stringSchema("Radarr movie id")}, []string{"movie_id"}),
		},
		{
			Name:        "radarr_get_movie_file",
			Description: "Fetch Radarr movie-file metadata by movie_file_id, including quality, languages, and mediaInfo when Radarr has it.",
			Parameters:  objectSchema(map[string]any{"movie_file_id": stringSchema("Radarr movie file id")}, []string{"movie_file_id"}),
		},
		{
			Name:        "radarr_get_queue",
			Description: "Read the current Radarr queue.",
			Parameters:  objectSchema(map[string]any{}, nil),
		},
		{
			Name:        "radarr_get_blocklist",
			Description: "Read recent Radarr blocklist entries for failed or corrupt releases.",
			Parameters:  objectSchema(map[string]any{"page_size": numberSchema("Maximum entries to return")}, nil),
		},
		{
			Name:        "radarr_delete_blocklist_item",
			Description: "Remove one confirmed Radarr blocklist item by id so Radarr can search/download another release.",
			Parameters:  objectSchema(map[string]any{"blocklist_id": stringSchema("Radarr blocklist item id")}, []string{"blocklist_id"}),
		},
		{
			Name:        "radarr_search_movie",
			Description: "Trigger a Radarr search for a specific movie id.",
			Parameters:  objectSchema(map[string]any{"movie_id": stringSchema("Radarr movie id")}, []string{"movie_id"}),
		},
		{
			Name:        "radarr_refresh_movie",
			Description: "Trigger a Radarr refresh/rescan command for a known movie id.",
			Parameters:  objectSchema(map[string]any{"movie_id": stringSchema("Radarr movie id")}, []string{"movie_id"}),
		},
		{
			Name:        "radarr_retry_queue_item",
			Description: "Retry/grab a known Radarr queue item id.",
			Parameters:  objectSchema(map[string]any{"queue_id": stringSchema("Radarr queue item id")}, []string{"queue_id"}),
		},
		{
			Name:        "sabnzbd_get_queue",
			Description: "Read the current SABnzbd queue for stuck or active download jobs.",
			Parameters:  objectSchema(map[string]any{}, nil),
		},
		{
			Name:        "sabnzbd_get_history",
			Description: "Read recent SABnzbd history for completed or failed download jobs.",
			Parameters:  objectSchema(map[string]any{"limit": numberSchema("Maximum history entries to return")}, nil),
		},
		{
			Name:        "fs_stat_path",
			Description: "Read metadata for a filesystem path under an allowed root.",
			Parameters:  objectSchema(map[string]any{"path": stringSchema("Absolute filesystem path to inspect")}, []string{"path"}),
		},
		{
			Name:        "fs_list_dir",
			Description: "List entries in a directory under an allowed root.",
			Parameters:  objectSchema(map[string]any{"path": stringSchema("Absolute directory path to list")}, []string{"path"}),
		},
		{
			Name:        "fs_find_recent",
			Description: "Find recently modified files under an allowed root.",
			Parameters: objectSchema(map[string]any{
				"root":  stringSchema("Absolute allowed root or subdirectory to search"),
				"limit": numberSchema("Maximum entries to return"),
			}, []string{"root"}),
		},
		{
			Name:        "fs_disk_usage",
			Description: "Report filesystem usage for an allowed root or subpath.",
			Parameters:  objectSchema(map[string]any{"path": stringSchema("Absolute path under an allowed root")}, []string{"path"}),
		},
	}
	if strings.TrimSpace(r.cfg.ExaAPIKey) != "" {
		defs = append(defs, toolDef{
			Name:        "web_search",
			Description: "Search the public web for current or external facts using Exa. Use after local media-server tools when an answer depends on outside facts, such as release availability, language/audio-track availability, schedules, or public metadata.",
			Parameters: objectSchema(map[string]any{
				"query": stringSchema("Search query"),
				"limit": numberSchema("Maximum search results to return, from 1 to 10"),
			}, []string{"query"}),
		})
	}
	out := make([]any, 0, len(defs))
	for _, def := range defs {
		out = append(out, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        def.Name,
				"description": def.Description,
				"parameters":  def.Parameters,
			},
		})
	}
	return out
}

func (r *Registry) Call(ctx context.Context, name string, args map[string]any) (any, error) {
	switch name {
	case "seerr_get_request":
		return r.seerr(ctx, http.MethodGet, "/api/v1/request/"+pathID(args, "request_id"), nil)
	case "seerr_get_issue":
		return r.seerr(ctx, http.MethodGet, "/api/v1/issue/"+pathID(args, "issue_id"), nil)
	case "seerr_comment_issue":
		return r.CommentIssue(ctx, stringArg(args, "issue_id"), stringArg(args, "message"))
	case "seerr_resolve_issue":
		return r.ResolveIssue(ctx, stringArg(args, "issue_id"))
	case "jellyfin_search_items":
		values := url.Values{"searchTerm": []string{stringArg(args, "query")}, "recursive": []string{"true"}, "limit": []string{"10"}}
		return r.jellyfin(ctx, http.MethodGet, "/Items?"+values.Encode(), nil)
	case "jellyfin_get_item":
		return r.jellyfin(ctx, http.MethodGet, "/Items/"+pathID(args, "item_id"), nil)
	case "jellyfin_get_item_media_info":
		return r.jellyfinItemMediaInfo(ctx, stringArg(args, "item_id"))
	case "jellyfin_get_child_media_info":
		return r.jellyfinChildMediaInfo(ctx, stringArg(args, "item_id"), intArg(args, "limit"))
	case "jellyfin_refresh_item":
		values := url.Values{
			"Recursive":           []string{"true"},
			"ImageRefreshMode":    []string{"Default"},
			"MetadataRefreshMode": []string{"Default"},
		}
		return r.jellyfin(ctx, http.MethodPost, "/Items/"+pathID(args, "item_id")+"/Refresh?"+values.Encode(), nil)
	case "sonarr_get_series_by_tvdb_id":
		tvdbID, err := strconv.Atoi(stringArg(args, "tvdb_id"))
		if err != nil {
			return nil, fmt.Errorf("tvdb_id must be numeric")
		}
		return r.arr(ctx, "sonarr", http.MethodGet, fmt.Sprintf("/api/v3/series?tvdbId=%d", tvdbID), nil)
	case "sonarr_get_queue":
		return r.arr(ctx, "sonarr", http.MethodGet, "/api/v3/queue?page=1&pageSize=20", nil)
	case "sonarr_get_blocklist":
		pageSize := intArg(args, "page_size")
		if pageSize <= 0 || pageSize > 100 {
			pageSize = 50
		}
		return r.arr(ctx, "sonarr", http.MethodGet, fmt.Sprintf("/api/v3/blocklist?page=1&pageSize=%d&sortKey=date&sortDirection=descending", pageSize), nil)
	case "sonarr_delete_blocklist_item":
		return r.arr(ctx, "sonarr", http.MethodDelete, "/api/v3/blocklist/"+pathID(args, "blocklist_id"), nil)
	case "sonarr_get_episodes_by_series_id":
		seriesID, err := strconv.Atoi(stringArg(args, "series_id"))
		if err != nil {
			return nil, fmt.Errorf("series_id must be numeric")
		}
		return r.arr(ctx, "sonarr", http.MethodGet, fmt.Sprintf("/api/v3/episode?seriesId=%d", seriesID), nil)
	case "sonarr_get_episode_file":
		episodeFileID, err := strconv.Atoi(stringArg(args, "episode_file_id"))
		if err != nil {
			return nil, fmt.Errorf("episode_file_id must be numeric")
		}
		return r.arr(ctx, "sonarr", http.MethodGet, fmt.Sprintf("/api/v3/episodefile/%d", episodeFileID), nil)
	case "sonarr_get_episode_files_by_series_id":
		seriesID, err := strconv.Atoi(stringArg(args, "series_id"))
		if err != nil {
			return nil, fmt.Errorf("series_id must be numeric")
		}
		values := url.Values{"seriesId": []string{strconv.Itoa(seriesID)}}
		if seasonNumber := strings.TrimSpace(stringArg(args, "season_number")); seasonNumber != "" {
			if _, err := strconv.Atoi(seasonNumber); err != nil {
				return nil, fmt.Errorf("season_number must be numeric")
			}
			values.Set("seasonNumber", seasonNumber)
		}
		return r.arr(ctx, "sonarr", http.MethodGet, "/api/v3/episodefile?"+values.Encode(), nil)
	case "sonarr_search_episode":
		episodeID, err := strconv.Atoi(stringArg(args, "episode_id"))
		if err != nil {
			return nil, fmt.Errorf("episode_id must be numeric")
		}
		return r.arr(ctx, "sonarr", http.MethodPost, "/api/v3/command", map[string]any{"name": "EpisodeSearch", "episodeIds": []int{episodeID}})
	case "sonarr_search_season":
		seriesID, err := strconv.Atoi(stringArg(args, "series_id"))
		if err != nil {
			return nil, fmt.Errorf("series_id must be numeric")
		}
		seasonNumber, err := strconv.Atoi(stringArg(args, "season_number"))
		if err != nil {
			return nil, fmt.Errorf("season_number must be numeric")
		}
		return r.arr(ctx, "sonarr", http.MethodPost, "/api/v3/command", map[string]any{"name": "SeasonSearch", "seriesId": seriesID, "seasonNumber": seasonNumber})
	case "sonarr_search_series":
		seriesID, err := strconv.Atoi(stringArg(args, "series_id"))
		if err != nil {
			return nil, fmt.Errorf("series_id must be numeric")
		}
		return r.arr(ctx, "sonarr", http.MethodPost, "/api/v3/command", map[string]any{"name": "SeriesSearch", "seriesId": seriesID})
	case "sonarr_refresh_series":
		seriesID, err := strconv.Atoi(stringArg(args, "series_id"))
		if err != nil {
			return nil, fmt.Errorf("series_id must be numeric")
		}
		return r.arr(ctx, "sonarr", http.MethodPost, "/api/v3/command", map[string]any{"name": "RefreshSeries", "seriesId": seriesID})
	case "sonarr_retry_queue_item":
		return r.arr(ctx, "sonarr", http.MethodPost, "/api/v3/queue/grab/"+pathID(args, "queue_id"), nil)
	case "radarr_get_movie_by_tmdb_id":
		tmdbID, err := strconv.Atoi(stringArg(args, "tmdb_id"))
		if err != nil {
			return nil, fmt.Errorf("tmdb_id must be numeric")
		}
		return r.arr(ctx, "radarr", http.MethodGet, fmt.Sprintf("/api/v3/movie?tmdbId=%d", tmdbID), nil)
	case "radarr_get_movie_by_id":
		movieID, err := strconv.Atoi(stringArg(args, "movie_id"))
		if err != nil {
			return nil, fmt.Errorf("movie_id must be numeric")
		}
		return r.arr(ctx, "radarr", http.MethodGet, fmt.Sprintf("/api/v3/movie/%d", movieID), nil)
	case "radarr_get_movie_file":
		movieFileID, err := strconv.Atoi(stringArg(args, "movie_file_id"))
		if err != nil {
			return nil, fmt.Errorf("movie_file_id must be numeric")
		}
		return r.arr(ctx, "radarr", http.MethodGet, fmt.Sprintf("/api/v3/moviefile/%d", movieFileID), nil)
	case "radarr_get_queue":
		return r.arr(ctx, "radarr", http.MethodGet, "/api/v3/queue?page=1&pageSize=20", nil)
	case "radarr_get_blocklist":
		pageSize := intArg(args, "page_size")
		if pageSize <= 0 || pageSize > 100 {
			pageSize = 50
		}
		return r.arr(ctx, "radarr", http.MethodGet, fmt.Sprintf("/api/v3/blocklist?page=1&pageSize=%d&sortKey=date&sortDirection=descending", pageSize), nil)
	case "radarr_delete_blocklist_item":
		return r.arr(ctx, "radarr", http.MethodDelete, "/api/v3/blocklist/"+pathID(args, "blocklist_id"), nil)
	case "radarr_search_movie":
		movieID, err := strconv.Atoi(stringArg(args, "movie_id"))
		if err != nil {
			return nil, fmt.Errorf("movie_id must be numeric")
		}
		return r.arr(ctx, "radarr", http.MethodPost, "/api/v3/command", map[string]any{"name": "MoviesSearch", "movieIds": []int{movieID}})
	case "radarr_refresh_movie":
		movieID, err := strconv.Atoi(stringArg(args, "movie_id"))
		if err != nil {
			return nil, fmt.Errorf("movie_id must be numeric")
		}
		return r.arr(ctx, "radarr", http.MethodPost, "/api/v3/command", map[string]any{"name": "RefreshMovie", "movieIds": []int{movieID}})
	case "radarr_retry_queue_item":
		return r.arr(ctx, "radarr", http.MethodPost, "/api/v3/queue/grab/"+pathID(args, "queue_id"), nil)
	case "sabnzbd_get_queue":
		return r.sabnzbd(ctx, "queue", url.Values{})
	case "sabnzbd_get_history":
		values := url.Values{}
		if limit := intArg(args, "limit"); limit > 0 {
			values.Set("limit", strconv.Itoa(limit))
		}
		return r.sabnzbd(ctx, "history", values)
	case "fs_stat_path":
		return r.fsStat(stringArg(args, "path"))
	case "fs_list_dir":
		return r.fsList(stringArg(args, "path"))
	case "fs_find_recent":
		return r.fsFindRecent(stringArg(args, "root"), intArg(args, "limit"))
	case "fs_disk_usage":
		return r.fsDiskUsage(stringArg(args, "path"))
	case "web_search":
		return r.exaSearch(ctx, stringArg(args, "query"), intArg(args, "limit"))
	default:
		return nil, fmt.Errorf("unknown tool %q", name)
	}
}

func (r *Registry) CommentIssue(ctx context.Context, issueID, message string) (any, error) {
	headers := map[string]string{}
	if r.cfg.SeerrBotUserID != "" {
		headers["X-Api-User"] = r.cfg.SeerrBotUserID
	}
	body := map[string]any{"message": message}
	return r.doJSON(ctx, http.MethodPost, r.cfg.SeerrBaseURL, "/api/v1/issue/"+url.PathEscape(strings.TrimSpace(issueID))+"/comment", r.cfg.SeerrAPIKey, "X-Api-Key", headers, body)
}

func (r *Registry) ResolveIssue(ctx context.Context, issueID string) (any, error) {
	issueID = strings.TrimSpace(issueID)
	if issueID == "" {
		return nil, fmt.Errorf("issue_id is required")
	}
	return r.doJSON(ctx, http.MethodPost, r.cfg.SeerrBaseURL, "/api/v1/issue/"+url.PathEscape(issueID)+"/resolved", r.cfg.SeerrAPIKey, "X-Api-Key", nil, nil)
}

func (r *Registry) seerr(ctx context.Context, method, path string, body any) (any, error) {
	return r.doJSON(ctx, method, r.cfg.SeerrBaseURL, path, r.cfg.SeerrAPIKey, "X-Api-Key", nil, body)
}

func (r *Registry) jellyfin(ctx context.Context, method, path string, body any) (any, error) {
	return r.doJSON(ctx, method, r.cfg.JellyfinBaseURL, path, r.cfg.JellyfinAPIKey, "X-Emby-Token", nil, body)
}

func (r *Registry) jellyfinItemMediaInfo(ctx context.Context, itemID string) (any, error) {
	itemID = strings.TrimSpace(itemID)
	if itemID == "" {
		return nil, fmt.Errorf("item_id is required")
	}
	values := url.Values{}
	values.Set("Fields", "MediaSources,Path,ProviderIds")
	item, err := r.jellyfin(ctx, http.MethodGet, "/Items/"+url.PathEscape(itemID)+"?"+values.Encode(), nil)
	if err != nil {
		return nil, err
	}
	return summarizeJellyfinMediaItem(item), nil
}

func (r *Registry) jellyfinChildMediaInfo(ctx context.Context, parentID string, limit int) (any, error) {
	parentID = strings.TrimSpace(parentID)
	if parentID == "" {
		return nil, fmt.Errorf("item_id is required")
	}
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	values := url.Values{}
	values.Set("ParentId", parentID)
	values.Set("Recursive", "true")
	values.Set("IncludeItemTypes", "Movie,Episode,Video")
	values.Set("Fields", "MediaSources,Path,ProviderIds")
	values.Set("Limit", strconv.Itoa(limit))
	value, err := r.jellyfin(ctx, http.MethodGet, "/Items?"+values.Encode(), nil)
	if err != nil {
		return nil, err
	}
	envelope, ok := value.(map[string]any)
	if !ok {
		return value, nil
	}
	items, _ := envelope["Items"].([]any)
	out := make([]any, 0, len(items))
	for _, item := range items {
		out = append(out, summarizeJellyfinMediaItem(item))
	}
	return map[string]any{
		"parent_id":    parentID,
		"total_record": envelope["TotalRecordCount"],
		"items":        out,
	}, nil
}

func (r *Registry) arr(ctx context.Context, service, method, path string, body any) (any, error) {
	if service == "sonarr" {
		return r.doJSON(ctx, method, r.cfg.SonarrBaseURL, path, r.cfg.SonarrAPIKey, "X-Api-Key", nil, body)
	}
	return r.doJSON(ctx, method, r.cfg.RadarrBaseURL, path, r.cfg.RadarrAPIKey, "X-Api-Key", nil, body)
}

func (r *Registry) sabnzbd(ctx context.Context, mode string, values url.Values) (any, error) {
	if values == nil {
		values = url.Values{}
	}
	values.Set("mode", mode)
	values.Set("output", "json")
	values.Set("apikey", r.cfg.SabnzbdAPIKey)
	path := "/api?" + values.Encode()
	return r.doJSON(ctx, http.MethodGet, r.cfg.SabnzbdBaseURL, path, "configured", "X-Blitzcrank-Internal", nil, nil)
}

func (r *Registry) exaSearch(ctx context.Context, query string, limit int) (any, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, fmt.Errorf("query is required")
	}
	if r.cfg.ExaAPIKey == "" {
		return nil, fmt.Errorf("Exa search is not configured; set EXA_API_KEY")
	}
	if limit <= 0 || limit > 10 {
		limit = 5
	}

	body := map[string]any{
		"query":      query,
		"type":       "auto",
		"numResults": limit,
		"contents": map[string]any{
			"highlights": true,
		},
	}
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	baseURL := strings.TrimSpace(r.cfg.ExaBaseURL)
	if baseURL == "" {
		baseURL = "https://api.exa.ai"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+"/search", bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("x-api-key", r.cfg.ExaAPIKey)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")

	resp, err := r.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	payload, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("Exa search failed: %s: %s", resp.Status, strings.TrimSpace(string(payload)))
	}

	var envelope struct {
		RequestID   string `json:"requestId"`
		SearchType  string `json:"searchType"`
		CostDollars struct {
			Total float64 `json:"total"`
		} `json:"costDollars"`
		Results []struct {
			Title           string    `json:"title"`
			URL             string    `json:"url"`
			PublishedDate   string    `json:"publishedDate"`
			Author          string    `json:"author"`
			Highlights      []string  `json:"highlights"`
			HighlightScores []float64 `json:"highlightScores"`
			Summary         string    `json:"summary"`
		} `json:"results"`
		Error any `json:"error"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return nil, err
	}
	if envelope.Error != nil {
		return nil, fmt.Errorf("Exa search error: %v", envelope.Error)
	}

	results := make([]map[string]any, 0, len(envelope.Results))
	for _, item := range envelope.Results {
		if strings.TrimSpace(item.URL) == "" && strings.TrimSpace(item.Title) == "" {
			continue
		}
		result := map[string]any{
			"title":      item.Title,
			"url":        item.URL,
			"highlights": item.Highlights,
		}
		if item.PublishedDate != "" {
			result["published_date"] = item.PublishedDate
		}
		if item.Author != "" {
			result["author"] = item.Author
		}
		if len(item.HighlightScores) > 0 {
			result["highlight_scores"] = item.HighlightScores
		}
		if item.Summary != "" {
			result["summary"] = item.Summary
		}
		results = append(results, result)
	}
	out := map[string]any{
		"query":   query,
		"results": results,
	}
	if envelope.RequestID != "" {
		out["request_id"] = envelope.RequestID
	}
	if envelope.SearchType != "" {
		out["search_type"] = envelope.SearchType
	}
	if envelope.CostDollars.Total > 0 {
		out["cost_dollars"] = envelope.CostDollars.Total
	}
	return out, nil
}

func (r *Registry) fsStat(path string) (any, error) {
	path, err := r.allowedPath(path)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"path":     path,
		"name":     info.Name(),
		"size":     info.Size(),
		"mode":     info.Mode().String(),
		"is_dir":   info.IsDir(),
		"mod_time": info.ModTime().UTC().Format(time.RFC3339),
	}, nil
}

func (r *Registry) fsList(path string) (any, error) {
	path, err := r.allowedPath(path)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, err
	}
	var out []map[string]any
	for i, entry := range entries {
		if i >= 100 {
			break
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		out = append(out, map[string]any{
			"name":     entry.Name(),
			"path":     filepath.Join(path, entry.Name()),
			"size":     info.Size(),
			"mode":     info.Mode().String(),
			"is_dir":   entry.IsDir(),
			"mod_time": info.ModTime().UTC().Format(time.RFC3339),
		})
	}
	return map[string]any{"path": path, "entries": out}, nil
}

func (r *Registry) fsFindRecent(root string, limit int) (any, error) {
	root, err := r.allowedPath(root)
	if err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	var files []map[string]any
	err = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return nil
		}
		files = append(files, map[string]any{
			"path":     path,
			"size":     info.Size(),
			"mode":     info.Mode().String(),
			"mod_time": info.ModTime().UTC().Format(time.RFC3339),
			"mod_unix": info.ModTime().Unix(),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sortRecent(files)
	if len(files) > limit {
		files = files[:limit]
	}
	for _, file := range files {
		delete(file, "mod_unix")
	}
	return map[string]any{"root": root, "files": files}, nil
}

func (r *Registry) fsDiskUsage(path string) (any, error) {
	path, err := r.allowedPath(path)
	if err != nil {
		return nil, err
	}
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return nil, err
	}
	total := stat.Blocks * uint64(stat.Bsize)
	free := stat.Bavail * uint64(stat.Bsize)
	return map[string]any{
		"path":        path,
		"total_bytes": total,
		"free_bytes":  free,
		"used_bytes":  total - free,
	}, nil
}

func (r *Registry) allowedPath(path string) (string, error) {
	if len(r.cfg.FSAllowedRoots) == 0 {
		return "", fmt.Errorf("filesystem tools are not configured; set FS_TOOL_ALLOWED_ROOTS")
	}
	clean, err := filepath.Abs(strings.TrimSpace(path))
	if err != nil {
		return "", err
	}
	for _, root := range r.cfg.FSAllowedRoots {
		root = strings.TrimSpace(root)
		if root == "" {
			continue
		}
		absRoot, err := filepath.Abs(root)
		if err != nil {
			continue
		}
		rel, err := filepath.Rel(absRoot, clean)
		if err == nil && (rel == "." || (!strings.HasPrefix(rel, ".."+string(filepath.Separator)) && rel != "..")) {
			return clean, nil
		}
	}
	return "", fmt.Errorf("path %q is outside FS_TOOL_ALLOWED_ROOTS", clean)
}

func sortRecent(files []map[string]any) {
	sort.Slice(files, func(i, j int) bool {
		left, _ := files[i]["mod_unix"].(int64)
		right, _ := files[j]["mod_unix"].(int64)
		return left > right
	})
}

func summarizeJellyfinMediaItem(value any) any {
	item, ok := value.(map[string]any)
	if !ok {
		return value
	}

	out := map[string]any{}
	copyIfPresent(out, item, "Id", "id")
	copyIfPresent(out, item, "Name", "name")
	copyIfPresent(out, item, "Type", "type")
	copyIfPresent(out, item, "IndexNumber", "index_number")
	copyIfPresent(out, item, "ParentIndexNumber", "parent_index_number")
	copyIfPresent(out, item, "ProductionYear", "production_year")
	copyIfPresent(out, item, "ProviderIds", "provider_ids")

	sources, _ := item["MediaSources"].([]any)
	if len(sources) == 0 {
		if streams, ok := item["MediaStreams"].([]any); ok && len(streams) > 0 {
			sources = []any{map[string]any{"MediaStreams": streams}}
		}
	}

	mediaSources := make([]map[string]any, 0, len(sources))
	for _, sourceValue := range sources {
		source, ok := sourceValue.(map[string]any)
		if !ok {
			continue
		}
		summary := map[string]any{}
		copyIfPresent(summary, source, "Id", "id")
		copyIfPresent(summary, source, "Name", "name")
		copyIfPresent(summary, source, "Container", "container")
		copyIfPresent(summary, source, "Size", "size")
		copyIfPresent(summary, source, "RunTimeTicks", "run_time_ticks")
		copyIfPresent(summary, source, "VideoType", "video_type")
		copyIfPresent(summary, source, "Protocol", "protocol")
		copyIfPresent(summary, source, "DefaultAudioStreamIndex", "default_audio_stream_index")
		copyIfPresent(summary, source, "DefaultSubtitleStreamIndex", "default_subtitle_stream_index")

		streams, _ := source["MediaStreams"].([]any)
		audio, subtitles, video := summarizeJellyfinStreams(streams)
		summary["audio_tracks"] = audio
		summary["subtitle_tracks"] = subtitles
		summary["video_tracks"] = video
		mediaSources = append(mediaSources, summary)
	}
	out["media_sources"] = mediaSources
	return out
}

func summarizeJellyfinStreams(streams []any) ([]map[string]any, []map[string]any, []map[string]any) {
	audio := []map[string]any{}
	subtitles := []map[string]any{}
	video := []map[string]any{}
	for _, streamValue := range streams {
		stream, ok := streamValue.(map[string]any)
		if !ok {
			continue
		}
		summary := map[string]any{}
		for sourceKey, destKey := range map[string]string{
			"Index":                "index",
			"Type":                 "type",
			"Codec":                "codec",
			"CodecTag":             "codec_tag",
			"Profile":              "profile",
			"Language":             "language",
			"Title":                "title",
			"DisplayTitle":         "display_title",
			"ChannelLayout":        "channel_layout",
			"Channels":             "channels",
			"BitRate":              "bit_rate",
			"SampleRate":           "sample_rate",
			"Width":                "width",
			"Height":               "height",
			"AverageFrameRate":     "average_frame_rate",
			"IsDefault":            "is_default",
			"IsForced":             "is_forced",
			"IsExternal":           "is_external",
			"DeliveryMethod":       "delivery_method",
			"IsTextSubtitleStream": "is_text_subtitle_stream",
		} {
			copyIfPresent(summary, stream, sourceKey, destKey)
		}
		switch strings.ToLower(strings.TrimSpace(fmt.Sprint(stream["Type"]))) {
		case "audio":
			audio = append(audio, summary)
		case "subtitle":
			subtitles = append(subtitles, summary)
		case "video":
			video = append(video, summary)
		}
	}
	return audio, subtitles, video
}

func copyIfPresent(dst, src map[string]any, sourceKey, destKey string) {
	value, ok := src[sourceKey]
	if !ok || value == nil {
		return
	}
	if text, ok := value.(string); ok && strings.TrimSpace(text) == "" {
		return
	}
	dst[destKey] = value
}

func (r *Registry) doJSON(ctx context.Context, method, baseURL, path, apiKey, apiHeader string, headers map[string]string, body any) (any, error) {
	if baseURL == "" || apiKey == "" {
		return nil, fmt.Errorf("service is not configured")
	}

	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(baseURL, "/")+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set(apiHeader, apiKey)
	req.Header.Set("Accept", "application/json")
	for key, value := range headers {
		if value != "" {
			req.Header.Set(key, value)
		}
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := r.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("%s %s failed: %s: %s", method, path, resp.Status, strings.TrimSpace(string(data)))
	}

	var decoded any
	if err := json.Unmarshal(data, &decoded); err != nil {
		return string(data), nil
	}
	return decoded, nil
}

func objectSchema(properties map[string]any, required []string) map[string]any {
	if required == nil {
		required = []string{}
	}
	return map[string]any{
		"type":                 "object",
		"properties":           properties,
		"required":             required,
		"additionalProperties": false,
	}
}

func stringSchema(description string) map[string]any {
	return map[string]any{"type": "string", "description": description}
}

func stringArg(args map[string]any, key string) string {
	value, _ := args[key].(string)
	return strings.TrimSpace(value)
}

func intArg(args map[string]any, key string) int {
	switch value := args[key].(type) {
	case float64:
		return int(value)
	case int:
		return value
	case string:
		parsed, _ := strconv.Atoi(strings.TrimSpace(value))
		return parsed
	default:
		return 0
	}
}

func numberSchema(description string) map[string]any {
	return map[string]any{"type": "number", "description": description}
}

func pathID(args map[string]any, key string) string {
	return url.PathEscape(stringArg(args, key))
}
