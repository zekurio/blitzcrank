package tools

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
		"memory_list",
		"memory_search",
		"memory_get",
		"memory_upsert",
		"memory_delete",
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

func TestReadOnlyPolicyAllowsSandboxAndMemoryButOmitsResolve(t *testing.T) {
	registry := NewRegistry(config.Config{ExaAPIKey: "secret"})
	policy := ToolPolicy{ReadOnly: true}
	for _, name := range []string{"sandbox_run_typescript", "memory_get", "memory_upsert", "web_search"} {
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
	if hasToolWithPolicy(registry, "memory_get", policy) {
		t.Fatal("group policy exposed memory_get")
	}
}

func TestMemoryToolsCRUDAndCategorizedPath(t *testing.T) {
	dir := t.TempDir()
	registry := NewRegistry(config.Config{MemoriesDirectory: dir})
	args := map[string]any{
		"scope":    "automation",
		"key":      "hourly-stale-import-handler/manual-intervention/digimon-beatbreak-s01e31",
		"title":    "Digimon Beatbreak S01E31 wrong candidate",
		"content":  "Sonarr suggested S01E21 for a queued S01E31 download.",
		"tags":     "stale-import, wrong-episode",
		"metadata": `{"queue_id":"1633352971","download_id":"SABnzbd_nzo_sburz2ff"}`,
	}
	if _, err := registry.Call(context.Background(), "memory_upsert", args); err != nil {
		t.Fatalf("memory_upsert error = %v", err)
	}
	path := filepath.Join(dir, "automation", "hourly-stale-import-handler", "manual-intervention", "digimon-beatbreak-s01e31.md")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "---\n") || !strings.Contains(string(data), "Sonarr suggested S01E21") {
		t.Fatalf("memory file is not markdown with frontmatter:\n%s", string(data))
	}
	raw, err := registry.Call(context.Background(), "memory_get", map[string]any{
		"scope": "automation",
		"key":   "hourly-stale-import-handler/manual-intervention/digimon-beatbreak-s01e31",
	})
	if err != nil {
		t.Fatalf("memory_get error = %v", err)
	}
	record := raw.(memoryRecord)
	if record.Metadata["download_id"] != "SABnzbd_nzo_sburz2ff" {
		t.Fatalf("memory metadata = %#v", record.Metadata)
	}

	raw, err = registry.Call(context.Background(), "memory_list", map[string]any{
		"scope":      "automation",
		"key_prefix": "hourly-stale-import-handler",
		"tag":        "wrong-episode",
	})
	if err != nil {
		t.Fatalf("memory_list error = %v", err)
	}
	list := raw.(map[string]any)["memories"].([]memorySummary)
	if len(list) != 1 || list[0].Key != "hourly-stale-import-handler/manual-intervention/digimon-beatbreak-s01e31" {
		t.Fatalf("memory_list = %#v", list)
	}

	raw, err = registry.Call(context.Background(), "memory_search", map[string]any{"query": "s01e21"})
	if err != nil {
		t.Fatalf("memory_search error = %v", err)
	}
	search := raw.(map[string]any)["memories"].([]memoryRecord)
	if len(search) != 1 || search[0].Scope != "automation" {
		t.Fatalf("memory_search = %#v", search)
	}

	if _, err := registry.Call(context.Background(), "memory_delete", map[string]any{
		"scope": "automation",
		"key":   "hourly-stale-import-handler/manual-intervention/digimon-beatbreak-s01e31",
	}); err != nil {
		t.Fatalf("memory_delete error = %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("memory file still exists, stat err = %v", err)
	}
}

func TestMemoryToolsRejectUnsafePathSegments(t *testing.T) {
	registry := NewRegistry(config.Config{MemoriesDirectory: t.TempDir()})
	if _, err := registry.Call(context.Background(), "memory_upsert", map[string]any{
		"scope":   "automation",
		"key":     "../escape",
		"content": "bad",
	}); err == nil {
		t.Fatal("memory_upsert accepted unsafe key")
	}
	if _, err := registry.Call(context.Background(), "memory_get", map[string]any{
		"scope": "bad/scope",
		"key":   "x",
	}); err == nil {
		t.Fatal("memory_get accepted nested scope")
	}
}

func TestMemoryToolPolicy(t *testing.T) {
	registry := NewRegistry(config.Config{})
	if !hasToolWithPolicy(registry, "memory_get", ToolPolicy{ReadOnly: true}) {
		t.Fatal("read-only policy hid memory_get")
	}
	if !hasToolWithPolicy(registry, "memory_upsert", ToolPolicy{ReadOnly: true}) {
		t.Fatal("read-only policy hid memory_upsert")
	}
	if !registry.AllowedInReadOnly("memory_upsert") || !registry.AllowedInReadOnly("memory_delete") {
		t.Fatal("memory writes are not allowed in read-only media workflows")
	}
	if registry.RequiresApproval("memory_delete") {
		t.Fatal("memory_delete unexpectedly requires approval")
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
