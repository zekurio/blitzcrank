package tools

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

func (r *Registry) CommentIssue(ctx context.Context, issueID, message string) (any, error) {
	issueID = strings.TrimSpace(issueID)
	message = strings.TrimSpace(message)
	if issueID == "" {
		return nil, fmt.Errorf("issue_id is required")
	}
	if message == "" {
		return nil, fmt.Errorf("message is required")
	}
	headers := map[string]string{}
	if r.cfg.SeerrBotUserID != "" {
		headers["X-Api-User"] = r.cfg.SeerrBotUserID
	}
	body := map[string]any{"message": message}
	return r.doJSON(ctx, jsonRequest{Method: http.MethodPost, BaseURL: r.cfg.SeerrBaseURL, Path: "/api/v1/issue/" + url.PathEscape(issueID) + "/comment", APIKey: r.cfg.SeerrAPIKey, APIHeader: "X-Api-Key", Headers: headers, Body: body})
}

func (r *Registry) UpdateIssueComment(ctx context.Context, issueID, commentID, message string) (any, error) {
	issueID = strings.TrimSpace(issueID)
	commentID = strings.TrimSpace(commentID)
	message = strings.TrimSpace(message)
	if issueID == "" {
		return nil, fmt.Errorf("issue_id is required")
	}
	if commentID == "" {
		return nil, fmt.Errorf("comment_id is required")
	}
	if message == "" {
		return nil, fmt.Errorf("message is required")
	}
	headers := map[string]string{}
	if r.cfg.SeerrBotUserID != "" {
		headers["X-Api-User"] = r.cfg.SeerrBotUserID
	}
	body := map[string]any{"message": message}
	return r.doJSON(ctx, jsonRequest{Method: http.MethodPut, BaseURL: r.cfg.SeerrBaseURL, Path: "/api/v1/issue/" + url.PathEscape(issueID) + "/comment/" + url.PathEscape(commentID), APIKey: r.cfg.SeerrAPIKey, APIHeader: "X-Api-Key", Headers: headers, Body: body})
}

func (r *Registry) ResolveIssue(ctx context.Context, issueID string) (any, error) {
	issueID = strings.TrimSpace(issueID)
	if issueID == "" {
		return nil, fmt.Errorf("issue_id is required")
	}
	return r.doJSON(ctx, jsonRequest{Method: http.MethodPost, BaseURL: r.cfg.SeerrBaseURL, Path: "/api/v1/issue/" + url.PathEscape(issueID) + "/resolved", APIKey: r.cfg.SeerrAPIKey, APIHeader: "X-Api-Key"})
}

func (r *Registry) SeerrGetUser(ctx context.Context, userID string) (any, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return nil, fmt.Errorf("user_id is required")
	}
	return r.seerr(ctx, http.MethodGet, "/api/v1/user/"+url.PathEscape(userID), nil)
}

func (r *Registry) SeerrListUsers(ctx context.Context, take, skip int) (any, error) {
	if take <= 0 {
		take = 100
	}
	if skip < 0 {
		skip = 0
	}
	values := url.Values{}
	values.Set("take", strconv.Itoa(take))
	values.Set("skip", strconv.Itoa(skip))
	return r.seerr(ctx, http.MethodGet, "/api/v1/user?"+values.Encode(), nil)
}

func (r *Registry) SeerrFindUserByDiscordID(ctx context.Context, discordID string) (string, error) {
	discordID = strings.TrimSpace(discordID)
	if discordID == "" {
		return "", nil
	}
	const pageSize = 100
	for skip := 0; skip < 5000; skip += pageSize {
		value, err := r.SeerrListUsers(ctx, pageSize, skip)
		if err != nil {
			return "", err
		}
		envelope, ok := value.(map[string]any)
		if !ok {
			return "", fmt.Errorf("unexpected Seerr user list response")
		}
		results, _ := envelope["results"].([]any)
		users := seerrUserMaps(results)
		for _, user := range users {
			userID := seerrUserID(user)
			if userID != "" && seerrUserDiscordID(user) == discordID {
				return userID, nil
			}
		}
		for _, user := range users {
			userID := seerrUserID(user)
			if userID == "" {
				continue
			}
			settingsDiscordID, err := r.SeerrGetUserSettingsDiscordID(ctx, userID)
			if err != nil {
				return "", err
			}
			if settingsDiscordID == discordID {
				return userID, nil
			}
		}
		pageInfo, _ := envelope["pageInfo"].(map[string]any)
		resultCount := int(floatNumber(pageInfo["results"]))
		if len(results) == 0 || (resultCount > 0 && skip+len(results) >= resultCount) || len(results) < pageSize {
			break
		}
	}
	return "", nil
}

func (r *Registry) SeerrGetUserSettingsDiscordID(ctx context.Context, userID string) (string, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return "", nil
	}
	value, err := r.seerr(ctx, http.MethodGet, "/api/v1/user/"+url.PathEscape(userID)+"/settings/main", nil)
	if err != nil {
		return "", err
	}
	settings, ok := value.(map[string]any)
	if !ok {
		return "", fmt.Errorf("unexpected Seerr user settings response")
	}
	discordID := strings.TrimSpace(fmt.Sprint(settings["discordId"]))
	if discordID == "<nil>" {
		return "", nil
	}
	return discordID, nil
}

func (r *Registry) SeerrGetUserQuota(ctx context.Context, userID string) (any, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return nil, fmt.Errorf("user_id is required")
	}
	return r.seerr(ctx, http.MethodGet, "/api/v1/user/"+url.PathEscape(userID)+"/quota", nil)
}

func (r *Registry) SeerrRequestMedia(ctx context.Context, args map[string]any) (any, error) {
	userID, err := numericArg(args, "user_id")
	if err != nil {
		return nil, err
	}
	mediaType := strings.ToLower(strings.TrimSpace(stringArg(args, "media_type")))
	mediaID, err := numericArg(args, "media_id")
	if err != nil {
		return nil, err
	}
	switch mediaType {
	case "movie", "tv":
	default:
		return nil, fmt.Errorf("media_type must be movie or tv")
	}
	is4K, err := boolArg(args, "is_4k")
	if err != nil {
		return nil, err
	}
	body := map[string]any{
		"mediaType": mediaType,
		"mediaId":   mediaID,
		"userId":    userID,
		"is4k":      is4K,
	}
	if mediaType == "tv" {
		if seasons := parseSeasonNumbers(stringArg(args, "seasons")); len(seasons) > 0 {
			body["seasons"] = seasons
		}
	}
	return r.seerr(ctx, http.MethodPost, "/api/v1/request", body)
}

func (r *Registry) seerrSearchMedia(ctx context.Context, query string, page int) (any, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, fmt.Errorf("query is required")
	}
	if page < 1 {
		page = 1
	}
	values := url.Values{}
	values.Set("query", query)
	if page > 1 {
		values.Set("page", strconv.Itoa(page))
	}
	return r.seerr(ctx, http.MethodGet, "/api/v1/search?"+values.Encode(), nil)
}

func (r *Registry) seerr(ctx context.Context, method, path string, body any) (any, error) {
	if err := r.validateServiceConfigured("seerr"); err != nil {
		return nil, err
	}
	return r.doJSON(ctx, jsonRequest{Method: method, BaseURL: r.cfg.SeerrBaseURL, Path: path, APIKey: r.cfg.SeerrAPIKey, APIHeader: "X-Api-Key", Body: body})
}

func (r *Registry) jellyfin(ctx context.Context, method, path string, body any) (any, error) {
	if err := r.validateServiceConfigured("jellyfin"); err != nil {
		return nil, err
	}
	return r.doJSON(ctx, jsonRequest{
		Method:  method,
		BaseURL: r.cfg.JellyfinBaseURL,
		Path:    path,
		Headers: map[string]string{
			"Authorization": jellyfinAuthorizationHeader(r.cfg.JellyfinAPIKey),
		},
		Body: body,
	})
}

func jellyfinAuthorizationHeader(token string) string {
	return "MediaBrowser " + strings.Join([]string{
		jellyfinAuthParam("Token", token),
		jellyfinAuthParam("Client", "Blitzcrank"),
		jellyfinAuthParam("Device", "Blitzcrank Gateway"),
		jellyfinAuthParam("DeviceId", "blitzcrank-gateway"),
		jellyfinAuthParam("Version", "0.1.0"),
	}, ", ")
}

func jellyfinAuthParam(key, value string) string {
	return key + `="` + url.QueryEscape(value) + `"`
}

func (r *Registry) jellyfinListItems(ctx context.Context, args map[string]any) (any, error) {
	limit, err := intArg(args, "limit")
	if err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	values := url.Values{}
	values.Set("Limit", strconv.Itoa(limit))
	values.Set("Fields", "Path,ProviderIds,UserData,MediaSources")
	if parentID := stringArg(args, "parent_id"); parentID != "" {
		values.Set("ParentId", parentID)
	}
	if itemTypes := stringArg(args, "item_types"); itemTypes != "" {
		values.Set("IncludeItemTypes", itemTypes)
	}
	if query := stringArg(args, "query"); query != "" {
		values.Set("SearchTerm", query)
	}
	recursive, err := boolArg(args, "recursive")
	if err != nil {
		return nil, err
	}
	if recursive {
		values.Set("Recursive", "true")
	}
	path := "/Items"
	if userID := stringArg(args, "user_id"); userID != "" {
		path = "/Users/" + url.PathEscape(userID) + "/Items"
	}
	return r.jellyfin(ctx, http.MethodGet, path+"?"+values.Encode(), nil)
}

func (r *Registry) jellyfinGetItem(ctx context.Context, itemID, fields string) (any, error) {
	itemID = strings.TrimSpace(itemID)
	if itemID == "" {
		return nil, fmt.Errorf("item_id is required")
	}
	values := url.Values{}
	values.Set("Ids", itemID)
	values.Set("Limit", "1")
	if fields != "" {
		values.Set("Fields", fields)
	}
	value, err := r.jellyfin(ctx, http.MethodGet, "/Items?"+values.Encode(), nil)
	if err != nil {
		return nil, err
	}
	envelope, ok := value.(map[string]any)
	if !ok {
		return value, nil
	}
	items, _ := envelope["Items"].([]any)
	if len(items) == 0 {
		return nil, fmt.Errorf("jellyfin item %q not found", itemID)
	}
	return items[0], nil
}

func (r *Registry) jellyfinItemMediaInfo(ctx context.Context, itemID string) (any, error) {
	item, err := r.jellyfinGetItem(ctx, itemID, "MediaSources,Path,ProviderIds")
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

func (r *Registry) jellyfinFindUser(ctx context.Context, query string) (any, error) {
	query = strings.ToLower(strings.TrimSpace(query))
	if query == "" {
		return nil, fmt.Errorf("query is required")
	}
	value, err := r.jellyfin(ctx, http.MethodGet, "/Users", nil)
	if err != nil {
		return nil, err
	}
	users, ok := value.([]any)
	if !ok {
		return value, nil
	}
	matches := []map[string]any{}
	for _, userValue := range users {
		user, ok := userValue.(map[string]any)
		if !ok {
			continue
		}
		id := strings.ToLower(strings.TrimSpace(fmt.Sprint(user["Id"])))
		name := strings.ToLower(strings.TrimSpace(fmt.Sprint(user["Name"])))
		if !strings.Contains(id, query) && !strings.Contains(name, query) {
			continue
		}
		summary := map[string]any{}
		copyIfPresent(summary, user, "Id", "id")
		copyIfPresent(summary, user, "Name", "name")
		copyIfPresent(summary, user, "ServerId", "server_id")
		copyIfPresent(summary, user, "HasPassword", "has_password")
		copyIfPresent(summary, user, "HasConfiguredPassword", "has_configured_password")
		copyIfPresent(summary, user, "HasConfiguredEasyPassword", "has_configured_easy_password")
		copyIfPresent(summary, user, "LastLoginDate", "last_login_date")
		copyIfPresent(summary, user, "LastActivityDate", "last_activity_date")
		copyIfPresent(summary, user, "Policy", "policy")
		matches = append(matches, summary)
	}
	return map[string]any{"query": query, "users": matches}, nil
}

func (r *Registry) jellyfinUserItem(ctx context.Context, userID, itemID string) (any, error) {
	userID = strings.TrimSpace(userID)
	itemID = strings.TrimSpace(itemID)
	if userID == "" {
		return nil, fmt.Errorf("user_id is required")
	}
	if itemID == "" {
		return nil, fmt.Errorf("item_id is required")
	}
	values := url.Values{}
	values.Set("Fields", "Path,ProviderIds,UserData,MediaSources")
	return r.jellyfin(ctx, http.MethodGet, "/Users/"+url.PathEscape(userID)+"/Items/"+url.PathEscape(itemID)+"?"+values.Encode(), nil)
}

func (r *Registry) jellyfinItemUserData(ctx context.Context, userID, itemID string) (any, error) {
	userID = strings.TrimSpace(userID)
	itemID = strings.TrimSpace(itemID)
	if userID == "" {
		return nil, fmt.Errorf("user_id is required")
	}
	if itemID == "" {
		return nil, fmt.Errorf("item_id is required")
	}
	values := url.Values{}
	values.Set("userId", userID)
	return r.jellyfin(ctx, http.MethodGet, "/UserItems/"+url.PathEscape(itemID)+"/UserData?"+values.Encode(), nil)
}

func (r *Registry) arr(ctx context.Context, service, method, path string, body any) (any, error) {
	if err := r.validateServiceConfigured(service); err != nil {
		return nil, err
	}
	if service == "sonarr" {
		return r.doJSON(ctx, jsonRequest{Method: method, BaseURL: r.cfg.SonarrBaseURL, Path: path, APIKey: r.cfg.SonarrAPIKey, APIHeader: "X-Api-Key", Body: body})
	}
	return r.doJSON(ctx, jsonRequest{Method: method, BaseURL: r.cfg.RadarrBaseURL, Path: path, APIKey: r.cfg.RadarrAPIKey, APIHeader: "X-Api-Key", Body: body})
}

func (r *Registry) sabnzbd(ctx context.Context, mode string, values url.Values) (any, error) {
	if err := r.validateServiceConfigured("sabnzbd"); err != nil {
		return nil, err
	}
	if values == nil {
		values = url.Values{}
	}
	values.Set("mode", mode)
	values.Set("output", "json")
	values.Set("apikey", r.cfg.SabnzbdAPIKey)
	path := "/api?" + values.Encode()
	return r.doJSON(ctx, jsonRequest{Method: http.MethodGet, BaseURL: r.cfg.SabnzbdBaseURL, Path: path, APIKey: "configured", APIHeader: "X-Blitzcrank-Internal"})
}
