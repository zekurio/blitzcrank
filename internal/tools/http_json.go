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

type jsonRequest struct {
	Method    string
	BaseURL   string
	Path      string
	APIKey    string
	APIHeader string
	Headers   map[string]string
	Body      any
}

func (r *Registry) doJSON(ctx context.Context, request jsonRequest) (any, error) {
	if request.BaseURL == "" || request.APIKey == "" {
		return nil, fmt.Errorf("service is not configured")
	}

	var reader io.Reader
	if request.Body != nil {
		data, err := json.Marshal(request.Body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, request.Method, strings.TrimRight(request.BaseURL, "/")+request.Path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set(request.APIHeader, request.APIKey)
	req.Header.Set("Accept", "application/json")
	for key, value := range request.Headers {
		if value != "" {
			req.Header.Set(key, value)
		}
	}
	if request.Body != nil {
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
		return nil, fmt.Errorf("%s %s failed: %s: %s", request.Method, request.Path, resp.Status, strings.TrimSpace(string(data)))
	}

	var decoded any
	if err := json.Unmarshal(data, &decoded); err != nil {
		return string(data), nil
	}
	return decoded, nil
}
