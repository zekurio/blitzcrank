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
	headers := map[string]string{}
	if r.cfg.SeerrBotUserID != "" {
		headers["X-Api-User"] = r.cfg.SeerrBotUserID
	}
	body := map[string]any{"message": message}
	return r.doJSON(ctx, jsonRequest{Method: http.MethodPost, BaseURL: r.cfg.SeerrBaseURL, Path: "/api/v1/issue/" + url.PathEscape(strings.TrimSpace(issueID)) + "/comment", APIKey: r.cfg.SeerrAPIKey, APIHeader: "X-Api-Key", Headers: headers, Body: body})
}

func (r *Registry) ResolveIssue(ctx context.Context, issueID string) (any, error) {
	issueID = strings.TrimSpace(issueID)
	if issueID == "" {
		return nil, fmt.Errorf("issue_id is required")
	}
	return r.doJSON(ctx, jsonRequest{Method: http.MethodPost, BaseURL: r.cfg.SeerrBaseURL, Path: "/api/v1/issue/" + url.PathEscape(issueID) + "/resolved", APIKey: r.cfg.SeerrAPIKey, APIHeader: "X-Api-Key"})
}

func (r *Registry) seerr(ctx context.Context, method, path string, body any) (any, error) {
	return r.doJSON(ctx, jsonRequest{Method: method, BaseURL: r.cfg.SeerrBaseURL, Path: path, APIKey: r.cfg.SeerrAPIKey, APIHeader: "X-Api-Key", Body: body})
}

func (r *Registry) jellyfin(ctx context.Context, method, path string, body any) (any, error) {
	return r.doJSON(ctx, jsonRequest{Method: method, BaseURL: r.cfg.JellyfinBaseURL, Path: path, APIKey: r.cfg.JellyfinAPIKey, APIHeader: "X-Emby-Token", Body: body})
}

func (r *Registry) jellyfinListItems(ctx context.Context, args map[string]any) (any, error) {
	limit := intArg(args, "limit")
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
	if boolArg(args, "recursive") {
		values.Set("Recursive", "true")
	}
	path := "/Items"
	if userID := stringArg(args, "user_id"); userID != "" {
		path = "/Users/" + url.PathEscape(userID) + "/Items"
	}
	return r.jellyfin(ctx, http.MethodGet, path+"?"+values.Encode(), nil)
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
	if service == "sonarr" {
		return r.doJSON(ctx, jsonRequest{Method: method, BaseURL: r.cfg.SonarrBaseURL, Path: path, APIKey: r.cfg.SonarrAPIKey, APIHeader: "X-Api-Key", Body: body})
	}
	return r.doJSON(ctx, jsonRequest{Method: method, BaseURL: r.cfg.RadarrBaseURL, Path: path, APIKey: r.cfg.RadarrAPIKey, APIHeader: "X-Api-Key", Body: body})
}

func (r *Registry) sabnzbd(ctx context.Context, mode string, values url.Values) (any, error) {
	if values == nil {
		values = url.Values{}
	}
	values.Set("mode", mode)
	values.Set("output", "json")
	values.Set("apikey", r.cfg.SabnzbdAPIKey)
	path := "/api?" + values.Encode()
	return r.doJSON(ctx, jsonRequest{Method: http.MethodGet, BaseURL: r.cfg.SabnzbdBaseURL, Path: path, APIKey: "configured", APIHeader: "X-Blitzcrank-Internal"})
}
