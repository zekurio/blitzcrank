package tools

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
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
	headers := r.seerrUserHeaders()
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
	headers := r.seerrUserHeaders()
	body := map[string]any{"message": message}
	return r.doJSON(ctx, jsonRequest{Method: http.MethodPut, BaseURL: r.cfg.SeerrBaseURL, Path: "/api/v1/issue/" + url.PathEscape(issueID) + "/comment/" + url.PathEscape(commentID), APIKey: r.cfg.SeerrAPIKey, APIHeader: "X-Api-Key", Headers: headers, Body: body})
}

func (r *Registry) DeleteIssueComment(ctx context.Context, issueID, commentID string) (any, error) {
	issueID = strings.TrimSpace(issueID)
	commentID = strings.TrimSpace(commentID)
	if issueID == "" {
		return nil, fmt.Errorf("issue_id is required")
	}
	if commentID == "" {
		return nil, fmt.Errorf("comment_id is required")
	}
	return r.doJSON(ctx, jsonRequest{Method: http.MethodDelete, BaseURL: r.cfg.SeerrBaseURL, Path: "/api/v1/issue/" + url.PathEscape(issueID) + "/comment/" + url.PathEscape(commentID), APIKey: r.cfg.SeerrAPIKey, APIHeader: "X-Api-Key", Headers: r.seerrUserHeaders()})
}

func (r *Registry) ResolveIssue(ctx context.Context, issueID string) (any, error) {
	issueID = strings.TrimSpace(issueID)
	if issueID == "" {
		return nil, fmt.Errorf("issue_id is required")
	}
	return r.doJSON(ctx, jsonRequest{Method: http.MethodPost, BaseURL: r.cfg.SeerrBaseURL, Path: "/api/v1/issue/" + url.PathEscape(issueID) + "/resolved", APIKey: r.cfg.SeerrAPIKey, APIHeader: "X-Api-Key", Headers: r.seerrUserHeaders()})
}

func (r *Registry) seerrUserHeaders() map[string]string {
	userID := strings.TrimSpace(r.cfg.SeerrBotUserID)
	if userID == "" {
		return nil
	}
	return map[string]string{"X-Api-User": userID}
}
