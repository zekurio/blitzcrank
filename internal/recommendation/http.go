package recommendation

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const defaultMaxResponseBytes int64 = 2 << 20

func catalogHTTPClient(client *http.Client) *http.Client {
	if client != nil {
		return client
	}
	return &http.Client{Timeout: 20 * time.Second}
}

func catalogBaseURL(value, fallback string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		value = fallback
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return "", fmt.Errorf("parse catalog base URL: %w", err)
	}
	if (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return "", fmt.Errorf("catalog base URL must be an absolute http(s) URL")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("catalog base URL must not contain credentials, query parameters, or fragments")
	}
	return strings.TrimRight(parsed.String(), "/"), nil
}

func responseLimit(value int64) int64 {
	if value > 0 {
		return value
	}
	return defaultMaxResponseBytes
}

// decodeCatalogResponse intentionally never includes response bodies in errors.
// Provider bodies can contain internal diagnostics and are not safe to surface
// in logs or Discord responses.
func decodeCatalogResponse(response *http.Response, limit int64, source string, target any) error {
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return fmt.Errorf("read %s response: %w", source, err)
	}
	if int64(len(data)) > limit {
		return fmt.Errorf("%s response exceeded %d bytes", source, limit)
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("%s request failed with HTTP %d", source, response.StatusCode)
	}
	if err := json.Unmarshal(data, target); err != nil {
		return fmt.Errorf("decode %s response: %w", source, err)
	}
	return nil
}
