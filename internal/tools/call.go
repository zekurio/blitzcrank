package tools

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

func (r *Registry) Call(ctx context.Context, name string, args map[string]any) (any, error) {
	for _, dispatch := range []func(context.Context, string, map[string]any) (any, bool, error){
		r.callSeerrTool,
		r.callJellyfinTool,
		r.callSonarrTool,
		r.callRadarrTool,
		r.callUtilityTool,
	} {
		value, handled, err := dispatch(ctx, name, args)
		if handled {
			return value, err
		}
	}
	return nil, fmt.Errorf("unknown tool %q", name)
}

func handled(value any, err error) (any, bool, error) {
	return value, true, err
}

func (r *Registry) callSeerrTool(ctx context.Context, name string, args map[string]any) (any, bool, error) {
	switch name {
	case "seerr_get_request":
		return handled(r.seerr(ctx, http.MethodGet, "/api/v1/request/"+pathID(args, "request_id"), nil))
	case "seerr_get_issue":
		return handled(r.seerr(ctx, http.MethodGet, "/api/v1/issue/"+pathID(args, "issue_id"), nil))
	case "seerr_comment_issue":
		return handled(r.CommentIssue(ctx, stringArg(args, "issue_id"), stringArg(args, "message")))
	case "seerr_resolve_issue":
		return handled(r.ResolveIssue(ctx, stringArg(args, "issue_id")))
	default:
		return nil, false, nil
	}
}

func (r *Registry) callJellyfinTool(ctx context.Context, name string, args map[string]any) (any, bool, error) {
	switch name {
	case "jellyfin_search_items":
		values := url.Values{"searchTerm": []string{stringArg(args, "query")}, "recursive": []string{"true"}, "limit": []string{"10"}}
		return handled(r.jellyfin(ctx, http.MethodGet, "/Items?"+values.Encode(), nil))
	case "jellyfin_list_items":
		return handled(r.jellyfinListItems(ctx, args))
	case "jellyfin_get_item":
		return handled(r.jellyfin(ctx, http.MethodGet, "/Items/"+pathID(args, "item_id"), nil))
	case "jellyfin_get_item_media_info":
		return handled(r.jellyfinItemMediaInfo(ctx, stringArg(args, "item_id")))
	case "jellyfin_get_child_media_info":
		return handled(r.jellyfinChildMediaInfo(ctx, stringArg(args, "item_id"), intArg(args, "limit")))
	case "jellyfin_refresh_item":
		values := url.Values{"Recursive": []string{"true"}, "ImageRefreshMode": []string{"Default"}, "MetadataRefreshMode": []string{"Default"}}
		return handled(r.jellyfin(ctx, http.MethodPost, "/Items/"+pathID(args, "item_id")+"/Refresh?"+values.Encode(), nil))
	case "jellyfin_list_libraries":
		return handled(r.jellyfin(ctx, http.MethodGet, "/Library/VirtualFolders", nil))
	case "jellyfin_list_users":
		return handled(r.jellyfin(ctx, http.MethodGet, "/Users", nil))
	case "jellyfin_find_user":
		return handled(r.jellyfinFindUser(ctx, stringArg(args, "query")))
	case "jellyfin_get_user":
		return handled(r.jellyfin(ctx, http.MethodGet, "/Users/"+pathID(args, "user_id"), nil))
	case "jellyfin_get_user_views":
		return handled(r.jellyfin(ctx, http.MethodGet, "/Users/"+pathID(args, "user_id")+"/Views", nil))
	case "jellyfin_get_user_item":
		return handled(r.jellyfinUserItem(ctx, stringArg(args, "user_id"), stringArg(args, "item_id")))
	case "jellyfin_get_item_user_data":
		return handled(r.jellyfinItemUserData(ctx, stringArg(args, "user_id"), stringArg(args, "item_id")))
	case "jellyfin_get_sessions":
		return handled(r.jellyfin(ctx, http.MethodGet, "/Sessions", nil))
	default:
		return nil, false, nil
	}
}

func (r *Registry) callSonarrTool(ctx context.Context, name string, args map[string]any) (any, bool, error) {
	switch name {
	case "sonarr_get_series_by_tvdb_id":
		id, err := numericArg(args, "tvdb_id")
		if err != nil {
			return nil, true, err
		}
		return handled(r.arr(ctx, "sonarr", http.MethodGet, fmt.Sprintf("/api/v3/series?tvdbId=%d", id), nil))
	case "sonarr_get_queue":
		return handled(r.arr(ctx, "sonarr", http.MethodGet, "/api/v3/queue?page=1&pageSize=20", nil))
	case "sonarr_get_blocklist":
		return handled(r.arr(ctx, "sonarr", http.MethodGet, blocklistPath(args), nil))
	case "sonarr_delete_blocklist_item":
		return handled(r.arr(ctx, "sonarr", http.MethodDelete, "/api/v3/blocklist/"+pathID(args, "blocklist_id"), nil))
	case "sonarr_get_episodes_by_series_id":
		id, err := numericArg(args, "series_id")
		if err != nil {
			return nil, true, err
		}
		return handled(r.arr(ctx, "sonarr", http.MethodGet, fmt.Sprintf("/api/v3/episode?seriesId=%d", id), nil))
	case "sonarr_get_episode_file":
		id, err := numericArg(args, "episode_file_id")
		if err != nil {
			return nil, true, err
		}
		return handled(r.arr(ctx, "sonarr", http.MethodGet, fmt.Sprintf("/api/v3/episodefile/%d", id), nil))
	case "sonarr_get_episode_files_by_series_id":
		path, err := sonarrEpisodeFilesPath(args)
		if err != nil {
			return nil, true, err
		}
		return handled(r.arr(ctx, "sonarr", http.MethodGet, path, nil))
	case "sonarr_search_episode":
		id, err := numericArg(args, "episode_id")
		if err != nil {
			return nil, true, err
		}
		return handled(r.arr(ctx, "sonarr", http.MethodPost, "/api/v3/command", map[string]any{"name": "EpisodeSearch", "episodeIds": []int{id}}))
	case "sonarr_search_season":
		body, err := sonarrSeasonSearchBody(args)
		if err != nil {
			return nil, true, err
		}
		return handled(r.arr(ctx, "sonarr", http.MethodPost, "/api/v3/command", body))
	case "sonarr_search_series", "sonarr_refresh_series":
		body, err := sonarrSeriesCommandBody(name, args)
		if err != nil {
			return nil, true, err
		}
		return handled(r.arr(ctx, "sonarr", http.MethodPost, "/api/v3/command", body))
	case "sonarr_retry_queue_item":
		return handled(r.arr(ctx, "sonarr", http.MethodPost, "/api/v3/queue/grab/"+pathID(args, "queue_id"), nil))
	default:
		return nil, false, nil
	}
}

func (r *Registry) callRadarrTool(ctx context.Context, name string, args map[string]any) (any, bool, error) {
	switch name {
	case "radarr_get_movie_by_tmdb_id":
		id, err := numericArg(args, "tmdb_id")
		if err != nil {
			return nil, true, err
		}
		return handled(r.arr(ctx, "radarr", http.MethodGet, fmt.Sprintf("/api/v3/movie?tmdbId=%d", id), nil))
	case "radarr_get_movie_by_id", "radarr_search_movie", "radarr_refresh_movie":
		return r.callRadarrMovieTool(ctx, name, args)
	case "radarr_get_movie_file":
		id, err := numericArg(args, "movie_file_id")
		if err != nil {
			return nil, true, err
		}
		return handled(r.arr(ctx, "radarr", http.MethodGet, fmt.Sprintf("/api/v3/moviefile/%d", id), nil))
	case "radarr_get_queue":
		return handled(r.arr(ctx, "radarr", http.MethodGet, "/api/v3/queue?page=1&pageSize=20", nil))
	case "radarr_get_blocklist":
		return handled(r.arr(ctx, "radarr", http.MethodGet, blocklistPath(args), nil))
	case "radarr_delete_blocklist_item":
		return handled(r.arr(ctx, "radarr", http.MethodDelete, "/api/v3/blocklist/"+pathID(args, "blocklist_id"), nil))
	case "radarr_retry_queue_item":
		return handled(r.arr(ctx, "radarr", http.MethodPost, "/api/v3/queue/grab/"+pathID(args, "queue_id"), nil))
	default:
		return nil, false, nil
	}
}

func (r *Registry) callUtilityTool(ctx context.Context, name string, args map[string]any) (any, bool, error) {
	switch name {
	case "sabnzbd_get_queue":
		return handled(r.sabnzbd(ctx, "queue", url.Values{}))
	case "sabnzbd_get_history":
		values := url.Values{}
		if limit := intArg(args, "limit"); limit > 0 {
			values.Set("limit", strconv.Itoa(limit))
		}
		return handled(r.sabnzbd(ctx, "history", values))
	case "fs_stat_path":
		return handled(r.fsStat(stringArg(args, "path")))
	case "fs_list_dir":
		return handled(r.fsList(stringArg(args, "path")))
	case "fs_find_recent":
		return handled(r.fsFindRecent(stringArg(args, "root"), intArg(args, "limit")))
	case "fs_disk_usage":
		return handled(r.fsDiskUsage(stringArg(args, "path")))
	case "web_search":
		return handled(r.exaSearch(ctx, stringArg(args, "query"), intArg(args, "limit")))
	default:
		return nil, false, nil
	}
}

func (r *Registry) callRadarrMovieTool(ctx context.Context, name string, args map[string]any) (any, bool, error) {
	movieID, err := numericArg(args, "movie_id")
	if err != nil {
		return nil, true, err
	}
	switch name {
	case "radarr_get_movie_by_id":
		return handled(r.arr(ctx, "radarr", http.MethodGet, fmt.Sprintf("/api/v3/movie/%d", movieID), nil))
	case "radarr_search_movie":
		return handled(r.arr(ctx, "radarr", http.MethodPost, "/api/v3/command", map[string]any{"name": "MoviesSearch", "movieIds": []int{movieID}}))
	default:
		return handled(r.arr(ctx, "radarr", http.MethodPost, "/api/v3/command", map[string]any{"name": "RefreshMovie", "movieIds": []int{movieID}}))
	}
}

func numericArg(args map[string]any, key string) (int, error) {
	id, err := strconv.Atoi(stringArg(args, key))
	if err != nil {
		return 0, fmt.Errorf("%s must be numeric", key)
	}
	return id, nil
}

func blocklistPath(args map[string]any) string {
	pageSize := intArg(args, "page_size")
	if pageSize <= 0 || pageSize > 100 {
		pageSize = 50
	}
	return fmt.Sprintf("/api/v3/blocklist?page=1&pageSize=%d&sortKey=date&sortDirection=descending", pageSize)
}

func sonarrEpisodeFilesPath(args map[string]any) (string, error) {
	seriesID, err := numericArg(args, "series_id")
	if err != nil {
		return "", err
	}
	values := url.Values{"seriesId": []string{strconv.Itoa(seriesID)}}
	if seasonNumber := strings.TrimSpace(stringArg(args, "season_number")); seasonNumber != "" {
		if _, err := strconv.Atoi(seasonNumber); err != nil {
			return "", fmt.Errorf("season_number must be numeric")
		}
		values.Set("seasonNumber", seasonNumber)
	}
	return "/api/v3/episodefile?" + values.Encode(), nil
}

func sonarrSeasonSearchBody(args map[string]any) (map[string]any, error) {
	seriesID, err := numericArg(args, "series_id")
	if err != nil {
		return nil, err
	}
	seasonNumber, err := numericArg(args, "season_number")
	if err != nil {
		return nil, err
	}
	return map[string]any{"name": "SeasonSearch", "seriesId": seriesID, "seasonNumber": seasonNumber}, nil
}

func sonarrSeriesCommandBody(name string, args map[string]any) (map[string]any, error) {
	seriesID, err := numericArg(args, "series_id")
	if err != nil {
		return nil, err
	}
	command := "SeriesSearch"
	if name == "sonarr_refresh_series" {
		command = "RefreshSeries"
	}
	return map[string]any{"name": command, "seriesId": seriesID}, nil
}
