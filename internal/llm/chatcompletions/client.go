package chatcompletions

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"blitzcrank/internal/llm/api"
)

type PayloadFunc func(api.ChatRequest) (any, error)

type Client struct {
	provider string
	apiKey   string
	baseURL  string
	headers  map[string]string
	payload  PayloadFunc
	http     *http.Client
}

func New(provider, apiKey, baseURL string, headers map[string]string, payload PayloadFunc) *Client {
	return &Client{
		provider: strings.TrimSpace(provider),
		apiKey:   apiKey,
		baseURL:  strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		headers:  headers,
		payload:  payload,
		http: &http.Client{
			Timeout: 90 * time.Second,
		},
	}
}

func (c *Client) Chat(ctx context.Context, request api.ChatRequest) (api.ChatResponse, error) {
	bodyPayload, err := c.payload(request)
	if err != nil {
		return api.ChatResponse{}, fmt.Errorf("build %s chat payload: %w", c.provider, err)
	}
	body, err := json.Marshal(bodyPayload)
	if err != nil {
		return api.ChatResponse{}, fmt.Errorf("encode %s chat payload: %w", c.provider, err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return api.ChatResponse{}, fmt.Errorf("create %s chat request: %w", c.provider, err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Content-Type", "application/json")
	for key, value := range c.headers {
		if strings.TrimSpace(value) != "" {
			req.Header.Set(key, value)
		}
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return api.ChatResponse{}, providerErrorFromTransport(c.provider, err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return api.ChatResponse{}, fmt.Errorf("read %s chat response: %w", c.provider, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return api.ChatResponse{}, api.ProviderErrorFromHTTP(c.provider, resp.StatusCode, resp.Header, data)
	}
	return parseChatCompletionResponse(c.provider, data)
}

func providerErrorFromTransport(provider string, err error) *api.ProviderError {
	kind := api.ErrorKindProviderUnavailable
	var netErr net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
		kind = api.ErrorKindTimeout
	}
	return &api.ProviderError{
		Provider: provider,
		Kind:     kind,
		Code:     "transport_error",
		Message:  err.Error(),
	}
}

func parseChatCompletionResponse(provider string, data []byte) (api.ChatResponse, error) {
	var envelope api.ErrorEnvelope
	if err := json.Unmarshal(data, &envelope); err == nil && envelope.Error != nil {
		return api.ChatResponse{}, api.ProviderErrorFromEnvelope(provider, 0, nil, data)
	}

	var output api.ChatResponse
	if err := json.Unmarshal(data, &output); err != nil {
		return api.ChatResponse{}, err
	}
	if len(output.Choices) == 0 {
		return api.ChatResponse{}, fmt.Errorf("%s chat completion returned no choices", provider)
	}
	return output, nil
}

func OpenAIChatCompletionPayload(request api.ChatRequest) (any, error) {
	payload := BasePayload(request)
	if effort := ReasoningEffortForWire(request.ReasoningEffort); effort != "" {
		payload["reasoning_effort"] = effort
	}
	return payload, nil
}

func BasePayload(request api.ChatRequest) map[string]any {
	payload := map[string]any{
		"model":    request.Model,
		"messages": request.Messages,
	}
	if len(request.Tools) > 0 {
		payload["tools"] = request.Tools
	}
	if request.ParallelToolCalls {
		payload["parallel_tool_calls"] = true
	}
	return payload
}

func ReasoningEffortForWire(value string) string {
	return strings.TrimSpace(value)
}
