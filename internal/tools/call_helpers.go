package tools

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

func numericArg(args map[string]any, key string) (int, error) {
	id, err := intArg(args, key)
	if err != nil {
		return 0, fmt.Errorf("%s must be numeric", key)
	}
	if id == 0 {
		if _, ok := args[key]; !ok {
			return 0, fmt.Errorf("%s must be numeric", key)
		}
		if strings.TrimSpace(fmt.Sprint(args[key])) == "" {
			return 0, fmt.Errorf("%s must be numeric", key)
		}
	}
	return id, nil
}

func blocklistPath(args map[string]any) (string, error) {
	pageSize, err := intArg(args, "page_size")
	if err != nil {
		return "", err
	}
	if pageSize <= 0 || pageSize > 100 {
		pageSize = 50
	}
	return fmt.Sprintf("/api/v3/blocklist?page=1&pageSize=%d&sortKey=date&sortDirection=descending", pageSize), nil
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

func sonarrManualImportPath(args map[string]any) (string, error) {
	values, err := manualImportValues(args)
	if err != nil {
		return "", err
	}
	if seriesID := strings.TrimSpace(stringArg(args, "series_id")); seriesID != "" {
		values.Set("seriesId", seriesID)
	}
	if seasonNumber := strings.TrimSpace(stringArg(args, "season_number")); seasonNumber != "" {
		values.Set("seasonNumber", seasonNumber)
	}
	return "/api/v3/manualimport?" + values.Encode(), nil
}

func radarrManualImportPath(args map[string]any) (string, error) {
	values, err := manualImportValues(args)
	if err != nil {
		return "", err
	}
	if movieID := strings.TrimSpace(stringArg(args, "movie_id")); movieID != "" {
		values.Set("movieId", movieID)
	}
	return "/api/v3/manualimport?" + values.Encode(), nil
}

func manualImportValues(args map[string]any) (url.Values, error) {
	values := url.Values{}
	if folder := strings.TrimSpace(stringArg(args, "folder")); folder != "" {
		values.Set("folder", folder)
	}
	if downloadID := strings.TrimSpace(stringArg(args, "download_id")); downloadID != "" {
		values.Set("downloadId", downloadID)
	}
	if _, ok := args["filter_existing_files"]; ok {
		filterExistingFiles, err := boolArg(args, "filter_existing_files")
		if err != nil {
			return nil, err
		}
		values.Set("filterExistingFiles", strconv.FormatBool(filterExistingFiles))
	}
	return values, nil
}

func manualImportBody(args map[string]any) ([]map[string]any, error) {
	candidate, err := manualImportCandidate(args)
	if err != nil {
		return nil, err
	}
	importMode := strings.TrimSpace(stringArg(args, "import_mode"))
	if importMode == "" {
		importMode = "Move"
	}
	candidate["importMode"] = importMode
	normalizeManualImportCandidate(candidate)
	return []map[string]any{candidate}, nil
}

func radarrManualImportCommandBody(args map[string]any) (map[string]any, error) {
	candidate, err := manualImportCandidate(args)
	if err != nil {
		return nil, err
	}
	normalizeManualImportCandidate(candidate)
	file := radarrManualImportFile(candidate)
	importMode := strings.TrimSpace(stringArg(args, "import_mode"))
	if importMode == "" || strings.EqualFold(importMode, "move") {
		importMode = "auto"
	}
	return map[string]any{
		"name":       "ManualImport",
		"files":      []map[string]any{file},
		"importMode": importMode,
	}, nil
}

func manualImportCandidate(args map[string]any) (map[string]any, error) {
	raw := stringArg(args, "candidate_json")
	if raw == "" {
		return nil, fmt.Errorf("candidate_json is required")
	}
	var candidate map[string]any
	if err := json.Unmarshal([]byte(raw), &candidate); err != nil {
		return nil, fmt.Errorf("candidate_json must be a JSON object: %w", err)
	}
	if len(candidate) == 0 {
		return nil, fmt.Errorf("candidate_json must not be empty")
	}
	force, err := boolArg(args, "force")
	if err != nil {
		return nil, err
	}
	if hasExplicitRejections(candidate["rejections"]) && !force {
		return nil, fmt.Errorf("manual import candidate has explicit rejections")
	}
	return candidate, nil
}

func radarrManualImportFile(candidate map[string]any) map[string]any {
	file := map[string]any{}
	for _, key := range []string{
		"path",
		"folderName",
		"quality",
		"languages",
		"releaseGroup",
		"indexerFlags",
		"downloadId",
		"movieId",
	} {
		if value, ok := candidate[key]; ok {
			file[key] = value
		}
	}
	return file
}

func hasExplicitRejections(value any) bool {
	switch typed := value.(type) {
	case []any:
		return len(typed) > 0
	case []map[string]any:
		return len(typed) > 0
	default:
		return false
	}
}

func normalizeManualImportCandidate(candidate map[string]any) {
	if _, ok := candidate["episodeIds"]; !ok {
		if episodes, ok := candidate["episodes"].([]any); ok {
			var ids []int
			for _, episode := range episodes {
				if object, ok := episode.(map[string]any); ok {
					if id := intFromAny(object["id"]); id > 0 {
						ids = append(ids, id)
					}
				}
			}
			if len(ids) > 0 {
				candidate["episodeIds"] = ids
			}
		}
	}
	if _, ok := candidate["movieId"]; !ok {
		if movie, ok := candidate["movie"].(map[string]any); ok {
			if id := intFromAny(movie["id"]); id > 0 {
				candidate["movieId"] = id
			}
		}
	}
}

func intFromAny(value any) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	case string:
		parsed, _ := strconv.Atoi(strings.TrimSpace(typed))
		return parsed
	default:
		return 0
	}
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
