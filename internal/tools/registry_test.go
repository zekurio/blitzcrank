package tools

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"blitzcrank/internal/config"
)

func TestOpenAIToolsRequiredIsAlwaysArray(t *testing.T) {
	registry := NewRegistry(config.Config{})
	for _, raw := range registry.OpenAITools() {
		tool := raw.(map[string]any)
		function := tool["function"].(map[string]any)
		parameters := function["parameters"].(map[string]any)
		if _, ok := parameters["required"].([]string); !ok {
			t.Fatalf("tool %s required = %#v, want []string", function["name"], parameters["required"])
		}
	}
}

func TestOpenAIToolSurfaceIsMinimalAfterSandboxMigration(t *testing.T) {
	registry := NewRegistry(config.Config{ExaAPIKey: "secret"})
	names := registry.ToolNamesForPolicy(ToolPolicy{})
	want := []string{
		"thread_history_search",
		"sandbox_run_typescript",
		"web_search",
	}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("tool names = %#v, want %#v", names, want)
	}
	for _, removed := range []string{"seerr_resolve_issue", "seerr_comment_issue", "jellyfin_search_items", "sonarr_get_queue", "radarr_get_queue", "sabnzbd_get_history", "fs_stat_path"} {
		if hasTool(registry, removed) {
			t.Fatalf("removed service tool %q is still exposed", removed)
		}
	}
}

func TestWebSearchToolOnlyRegisteredWhenConfigured(t *testing.T) {
	if hasTool(NewRegistry(config.Config{}), "web_search") {
		t.Fatal("web_search registered without EXA_API_KEY")
	}
	if !hasTool(NewRegistry(config.Config{ExaAPIKey: "secret"}), "web_search") {
		t.Fatal("web_search not registered with EXA_API_KEY")
	}
}

func TestReadOnlyPolicyAllowsSandboxAndWebButOmitsResolve(t *testing.T) {
	registry := NewRegistry(config.Config{ExaAPIKey: "secret"})
	policy := ToolPolicy{ReadOnly: true}
	for _, name := range []string{"thread_history_search", "sandbox_run_typescript", "web_search"} {
		if !hasToolWithPolicy(registry, name, policy) {
			t.Fatalf("read-only policy hid %s", name)
		}
	}
	for _, name := range []string{"seerr_resolve_issue", "sonarr_search_episode"} {
		if hasToolWithPolicy(registry, name, policy) {
			t.Fatalf("read-only policy exposed removed/mutating tool %s", name)
		}
	}
}

func TestToolPolicyFiltersByGroup(t *testing.T) {
	registry := NewRegistry(config.Config{ExaAPIKey: "secret"})
	policy := ToolPolicy{ReadOnly: true, Groups: []string{"sandbox", "web"}}
	if !hasToolWithPolicy(registry, "sandbox_run_typescript", policy) {
		t.Fatal("group policy hid sandbox_run_typescript")
	}
	if !hasToolWithPolicy(registry, "web_search", policy) {
		t.Fatal("group policy hid web_search")
	}
}

func TestResolveIssueRequestShape(t *testing.T) {
	var method, path string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method = r.Method
		path = r.URL.Path
		if r.Header.Get("X-Api-Key") != "secret" {
			t.Fatalf("X-Api-Key = %q", r.Header.Get("X-Api-Key"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":42,"status":"resolved"}`))
	}))
	defer server.Close()

	registry := NewRegistry(config.Config{SeerrBaseURL: server.URL, SeerrAPIKey: "secret"})
	if _, err := registry.ResolveIssue(context.Background(), "42"); err != nil {
		t.Fatalf("ResolveIssue error = %v", err)
	}
	if method != http.MethodPost || path != "/api/v1/issue/42/resolved" {
		t.Fatalf("request = %s %s", method, path)
	}
}

func TestCommentIssueValidatesInputs(t *testing.T) {
	registry := NewRegistry(config.Config{})
	if _, err := registry.CommentIssue(context.Background(), "", "fixed"); err == nil || !strings.Contains(err.Error(), "issue_id is required") {
		t.Fatalf("CommentIssue error = %v, want issue_id validation", err)
	}
	if _, err := registry.CommentIssue(context.Background(), "42", " "); err == nil || !strings.Contains(err.Error(), "message is required") {
		t.Fatalf("CommentIssue error = %v, want message validation", err)
	}
}

func TestDoJSONRejectsInvalidJSONResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`not-json`))
	}))
	defer server.Close()

	registry := NewRegistry(config.Config{})
	_, err := registry.doJSON(context.Background(), jsonRequest{Method: http.MethodGet, BaseURL: server.URL, Path: "/", APIKey: "secret", APIHeader: "X-Api-Key"})
	if err == nil || !strings.Contains(err.Error(), "invalid JSON") {
		t.Fatalf("error = %v, want invalid JSON", err)
	}
}

func TestDoJSONRejectsOversizedResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(strings.Repeat("x", maxJSONResponseBytes+1)))
	}))
	defer server.Close()

	registry := NewRegistry(config.Config{})
	_, err := registry.doJSON(context.Background(), jsonRequest{Method: http.MethodGet, BaseURL: server.URL, Path: "/", APIKey: "secret", APIHeader: "X-Api-Key"})
	if err == nil || !strings.Contains(err.Error(), "response exceeded") {
		t.Fatalf("error = %v, want oversized response", err)
	}
}

func TestExaWebSearchRequestShape(t *testing.T) {
	var apiKey string
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/search" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		apiKey = r.Header.Get("x-api-key")
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"requestId":"req_123",
			"results":[{
				"title":"Example",
				"url":"https://example.test",
				"publishedDate":"2026-05-16",
				"author":"Author",
				"highlights":["A relevant result"],
				"highlightScores":[0.91]
			}]
		}`))
	}))
	defer server.Close()

	registry := NewRegistry(config.Config{ExaBaseURL: server.URL, ExaAPIKey: "secret"})
	out, err := registry.Call(context.Background(), "web_search", map[string]any{"query": "project hail mary release", "limit": float64(3)})
	if err != nil {
		t.Fatalf("web_search error = %v", err)
	}
	if apiKey != "secret" {
		t.Fatalf("x-api-key = %q", apiKey)
	}
	if body["query"] != "project hail mary release" || body["type"] != "auto" || body["numResults"].(float64) != 3 {
		t.Fatalf("body = %#v", body)
	}
	results := out.(map[string]any)["results"].([]map[string]any)
	if len(results) != 1 || results[0]["url"] != "https://example.test" {
		t.Fatalf("results = %#v", results)
	}
}

func TestExaWebSearchHTTPError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"Invalid API key"}`))
	}))
	defer server.Close()

	registry := NewRegistry(config.Config{ExaBaseURL: server.URL, ExaAPIKey: "secret"})
	_, err := registry.Call(context.Background(), "web_search", map[string]any{"query": "test"})
	if err == nil || !strings.Contains(err.Error(), "Invalid API key") {
		t.Fatalf("error = %v, want Exa HTTP error", err)
	}
}

func TestInvalidScalarArgsReturnErrors(t *testing.T) {
	registry := NewRegistry(config.Config{ExaBaseURL: "http://example.invalid", ExaAPIKey: "secret"})
	if _, err := registry.Call(context.Background(), "web_search", map[string]any{"query": "test", "limit": "many"}); err == nil || !strings.Contains(err.Error(), "limit must be an integer") {
		t.Fatalf("web_search error = %v, want integer error", err)
	}
	if _, err := registry.Call(context.Background(), "web_search", map[string]any{"query": "test", "limit": 1.5}); err == nil || !strings.Contains(err.Error(), "limit must be an integer") {
		t.Fatalf("web_search error = %v, want fractional integer error", err)
	}
}

func hasTool(registry *Registry, name string) bool {
	return hasToolWithPolicy(registry, name, ToolPolicy{})
}

func hasToolWithPolicy(registry *Registry, name string, policy ToolPolicy) bool {
	for _, raw := range registry.OpenAIToolsForPolicy(policy) {
		tool := raw.(map[string]any)
		function := tool["function"].(map[string]any)
		if function["name"] == name {
			return true
		}
	}
	return false
}
