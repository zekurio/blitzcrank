package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"blitzcrank/internal/config"
)

type OpenAICompatible struct {
	apiKey  string
	baseURL string
	referer string
	title   string
	http    *http.Client
}

func NewOpenAICompatible(cfg config.Config) *OpenAICompatible {
	return &OpenAICompatible{
		apiKey:  cfg.OpenAIAPIKey,
		baseURL: strings.TrimRight(cfg.OpenAIBaseURL, "/"),
		referer: cfg.OpenAIReferer,
		title:   cfg.OpenAITitle,
		http: &http.Client{
			Timeout: 90 * time.Second,
		},
	}
}

func (c *OpenAICompatible) Chat(ctx context.Context, request ChatRequest) (ChatResponse, error) {
	body, err := json.Marshal(request)
	if err != nil {
		return ChatResponse{}, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return ChatResponse{}, err
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Content-Type", "application/json")
	if c.referer != "" {
		req.Header.Set("HTTP-Referer", c.referer)
	}
	if c.title != "" {
		req.Header.Set("X-Title", c.title)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return ChatResponse{}, err
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return ChatResponse{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return ChatResponse{}, fmt.Errorf("chat completion failed: %s: %s", resp.Status, strings.TrimSpace(string(data)))
	}

	var output ChatResponse
	if err := json.Unmarshal(data, &output); err != nil {
		return ChatResponse{}, err
	}
	if len(output.Choices) == 0 {
		return ChatResponse{}, fmt.Errorf("chat completion returned no choices")
	}
	return output, nil
}
