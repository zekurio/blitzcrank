package openrouter

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"blitzcrank/internal/config"
	"blitzcrank/internal/llm/api"
)

func TestOpenRouterNew(t *testing.T) {
	var client any = New(config.Config{OpenRouterAPIKey: "key"})
	if _, ok := client.(*OpenRouter); !ok {
		t.Fatalf("New() type = %T, want *OpenRouter", client)
	}
}

func TestOpenRouterDefaultsToOpenRouterBaseURL(t *testing.T) {
	if got := openRouterBaseURL(""); got != defaultOpenRouterBaseURL {
		t.Fatalf("baseURL = %q, want %q", got, defaultOpenRouterBaseURL)
	}
}

func TestOpenRouterChatUsesProviderHeadersAndReasoningObject(t *testing.T) {
	var payload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Fatalf("path = %q, want /chat/completions", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer key" {
			t.Fatalf("authorization = %q", got)
		}
		if got := r.Header.Get("HTTP-Referer"); got != "https://blitzcrank.example" {
			t.Fatalf("referer = %q", got)
		}
		if got := r.Header.Get("X-OpenRouter-Title"); got != "Blitzcrank" {
			t.Fatalf("title = %q", got)
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"done"}}]}`))
	}))
	defer server.Close()

	client := New(config.Config{
		OpenRouterAPIKey:  "key",
		OpenRouterBaseURL: server.URL,
		OpenRouterReferer: "https://blitzcrank.example",
		OpenRouterTitle:   "Blitzcrank",
	})
	response, err := client.Chat(context.Background(), api.ChatRequest{
		Model:           "anthropic/claude-sonnet-4.6",
		ReasoningEffort: "high",
		Messages:        []api.Message{{Role: "user", Content: "hi"}},
	})
	if err != nil {
		t.Fatalf("Chat() error = %v", err)
	}
	if got := response.FirstChoice().Message.Content; got != "done" {
		t.Fatalf("content = %q, want done", got)
	}
	if _, ok := payload["reasoning_effort"]; ok {
		t.Fatalf("payload unexpectedly included reasoning_effort: %#v", payload)
	}
	reasoning := payload["reasoning"].(map[string]any)
	if reasoning["effort"] != "high" {
		t.Fatalf("reasoning = %#v", reasoning)
	}
}

func TestOpenRouterChatSkipsNoneReasoning(t *testing.T) {
	var payload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"done"}}]}`))
	}))
	defer server.Close()

	client := New(config.Config{OpenRouterAPIKey: "key", OpenRouterBaseURL: server.URL})
	if _, err := client.Chat(context.Background(), api.ChatRequest{
		Model:           "openai/gpt-5.4-mini",
		ReasoningEffort: "none",
		Messages:        []api.Message{{Role: "user", Content: "hi"}},
	}); err != nil {
		t.Fatalf("Chat() error = %v", err)
	}
	if _, ok := payload["reasoning"]; ok {
		t.Fatalf("payload unexpectedly included reasoning: %#v", payload)
	}
}

func TestOpenRouterErrorIncludesKindAndRetryAfter(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "60")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"code":429,"message":"You are being rate limited"}}`))
	}))
	defer server.Close()

	client := New(config.Config{OpenRouterAPIKey: "key", OpenRouterBaseURL: server.URL})
	_, err := client.Chat(context.Background(), api.ChatRequest{
		Model:    "openai/gpt-5.4-mini",
		Messages: []api.Message{{Role: "user", Content: "hi"}},
	})
	var providerErr *api.ProviderError
	if !errors.As(err, &providerErr) {
		t.Fatalf("error = %T %v, want *api.ProviderError", err, err)
	}
	if providerErr.Provider != "openrouter" || providerErr.Kind != api.ErrorKindRateLimited || providerErr.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("provider error = %#v", providerErr)
	}
	if providerErr.RetryAfter != time.Minute {
		t.Fatalf("RetryAfter = %v, want 1m", providerErr.RetryAfter)
	}
}
