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

const maxJSONResponseBytes = 4 << 20

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
	if request.BaseURL == "" {
		return nil, fmt.Errorf("service base URL is not configured")
	}
	if request.APIHeader != "" && request.APIKey == "" {
		return nil, fmt.Errorf("service API key is not configured")
	}

	var reader io.Reader
	if request.Body != nil {
		data, err := json.Marshal(request.Body)
		if err != nil {
			return nil, fmt.Errorf("encode %s %s request body: %w", request.Method, request.Path, err)
		}
		reader = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, request.Method, strings.TrimRight(request.BaseURL, "/")+request.Path, reader)
	if err != nil {
		return nil, fmt.Errorf("create %s %s request: %w", request.Method, request.Path, err)
	}
	if request.APIHeader != "" {
		req.Header.Set(request.APIHeader, request.APIKey)
	}
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
		return nil, fmt.Errorf("send %s %s request: %w", request.Method, request.Path, err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, maxJSONResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read %s %s response: %w", request.Method, request.Path, err)
	}
	if len(data) > maxJSONResponseBytes {
		return nil, fmt.Errorf("%s %s response exceeded %d bytes", request.Method, request.Path, maxJSONResponseBytes)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("%s %s failed: %s: %s", request.Method, request.Path, resp.Status, strings.TrimSpace(string(data)))
	}
	if strings.TrimSpace(string(data)) == "" {
		return nil, nil
	}

	var decoded any
	if err := json.Unmarshal(data, &decoded); err != nil {
		return nil, fmt.Errorf("%s %s returned invalid JSON: %w", request.Method, request.Path, err)
	}
	return decoded, nil
}
