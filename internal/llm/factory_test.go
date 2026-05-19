package llm

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"blitzcrank/internal/config"
	"blitzcrank/internal/llm/codex"
	"blitzcrank/internal/llm/openai"
	"blitzcrank/internal/llm/openrouter"
)

func TestFactoryOpenAICompatible(t *testing.T) {
	client, err := New(config.Config{
		Provider:      ProviderOpenAICompatible,
		OpenAIBaseURL: "https://example.test/v1",
		OpenAIAPIKey:  "key",
	})
	if err != nil {
		t.Fatalf("New(%q) error = %v", ProviderOpenAICompatible, err)
	}
	if _, ok := client.(*openai.OpenAICompatible); !ok {
		t.Fatalf("New(%q) type = %T, want *OpenAICompatible", ProviderOpenAICompatible, client)
	}
}

func TestFactoryOpenRouter(t *testing.T) {
	client, err := New(config.Config{
		Provider:         ProviderOpenRouter,
		OpenRouterAPIKey: "key",
	})
	if err != nil {
		t.Fatalf("New(%q) error = %v", ProviderOpenRouter, err)
	}
	if _, ok := client.(*openrouter.OpenRouter); !ok {
		t.Fatalf("New(%q) type = %T, want *OpenRouter", ProviderOpenRouter, client)
	}
}

func TestFactoryCodexOAuth(t *testing.T) {
	authPath := filepath.Join(t.TempDir(), "auth.json")
	expiresAt := time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
	updatedAt := time.Now().UTC().Format(time.RFC3339Nano)
	if err := os.WriteFile(authPath, []byte(`{
		"version": 1,
		"profiles": {
			"default": {
				"access_token": "access",
				"refresh_token": "refresh",
				"expires_at": "`+expiresAt+`",
				"updated_at": "`+updatedAt+`"
			}
		}
	}`), 0o600); err != nil {
		t.Fatalf("write auth store: %v", err)
	}

	client, err := New(config.Config{
		Provider:         ProviderCodexOAuth,
		CodexAuthProfile: "default",
		CodexAuthStore:   authPath,
		CodexBaseURL:     "https://codex.example.test",
	})
	if err != nil {
		t.Fatalf("New(%q) error = %v", ProviderCodexOAuth, err)
	}
	if _, ok := client.(*codex.CodexOAuth); !ok {
		t.Fatalf("New(%q) type = %T, want *CodexOAuth", ProviderCodexOAuth, client)
	}

	client, err = New(config.Config{
		Provider:         ProviderOpenAI,
		OpenAIAuth:       ProviderCodexOAuth,
		CodexAuthProfile: "default",
		CodexAuthStore:   authPath,
		CodexBaseURL:     "https://codex.example.test",
	})
	if err != nil {
		t.Fatalf("New(%q with codex auth) error = %v", ProviderOpenAI, err)
	}
	if _, ok := client.(*codex.CodexOAuth); !ok {
		t.Fatalf("New(%q with codex auth) type = %T, want *CodexOAuth", ProviderOpenAI, client)
	}
}

func TestFactoryCodexOAuthFailure(t *testing.T) {
	_, err := New(config.Config{
		Provider:         ProviderCodexOAuth,
		CodexAuthProfile: "missing",
		CodexAuthStore:   filepath.Join(t.TempDir(), "auth.json"),
		CodexBaseURL:     "https://codex.example.test",
	})
	if err == nil {
		t.Fatal("New(codex-oauth) error = nil, want missing credentials error")
	}
}

func TestFactoryUnsupportedProvider(t *testing.T) {
	_, err := New(config.Config{Provider: "not-a-provider"})
	if err == nil {
		t.Fatal("New(unsupported) error = nil")
	}
	if !strings.Contains(err.Error(), "unsupported runtime provider") {
		t.Fatalf("error = %v, want unsupported runtime provider", err)
	}
	var providerErr *ProviderError
	if errors.As(err, &providerErr) {
		t.Fatalf("error = %T, did not expect ProviderError", err)
	}
}
