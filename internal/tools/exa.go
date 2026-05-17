package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type exaSearchEnvelope struct {
	RequestID   string `json:"requestId"`
	SearchType  string `json:"searchType"`
	CostDollars struct {
		Total float64 `json:"total"`
	} `json:"costDollars"`
	Results []exaSearchResult `json:"results"`
	Error   any               `json:"error"`
}

type exaSearchResult struct {
	Title           string    `json:"title"`
	URL             string    `json:"url"`
	PublishedDate   string    `json:"publishedDate"`
	Author          string    `json:"author"`
	Highlights      []string  `json:"highlights"`
	HighlightScores []float64 `json:"highlightScores"`
	Summary         string    `json:"summary"`
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

	req, err := r.newExaSearchRequest(ctx, query, limit)
	if err != nil {
		return nil, fmt.Errorf("create Exa search request: %w", err)
	}
	resp, err := r.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("send Exa search request: %w", err)
	}
	defer resp.Body.Close()

	envelope, err := decodeExaSearchResponse(resp)
	if err != nil {
		return nil, fmt.Errorf("decode Exa search response: %w", err)
	}
	return formatExaSearchOutput(query, envelope), nil
}

func (r *Registry) newExaSearchRequest(ctx context.Context, query string, limit int) (*http.Request, error) {
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
		return nil, fmt.Errorf("encode Exa search body: %w", err)
	}
	baseURL := strings.TrimSpace(r.cfg.ExaBaseURL)
	if baseURL == "" {
		baseURL = "https://api.exa.ai"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+"/search", bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("create HTTP request: %w", err)
	}
	req.Header.Set("x-api-key", r.cfg.ExaAPIKey)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	return req, nil
}

func decodeExaSearchResponse(resp *http.Response) (exaSearchEnvelope, error) {
	payload, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return exaSearchEnvelope{}, fmt.Errorf("read response body: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return exaSearchEnvelope{}, fmt.Errorf("Exa search failed: %s: %s", resp.Status, strings.TrimSpace(string(payload)))
	}

	var envelope exaSearchEnvelope
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return exaSearchEnvelope{}, fmt.Errorf("parse response body: %w", err)
	}
	if envelope.Error != nil {
		return exaSearchEnvelope{}, fmt.Errorf("Exa search error: %v", envelope.Error)
	}
	return envelope, nil
}

func formatExaSearchOutput(query string, envelope exaSearchEnvelope) map[string]any {
	results := make([]map[string]any, 0, len(envelope.Results))
	for _, item := range envelope.Results {
		if strings.TrimSpace(item.URL) == "" && strings.TrimSpace(item.Title) == "" {
			continue
		}
		results = append(results, formatExaSearchResult(item))
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
	return out
}

func formatExaSearchResult(item exaSearchResult) map[string]any {
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
	return result
}
