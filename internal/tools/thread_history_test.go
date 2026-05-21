package tools

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"blitzcrank/internal/config"
	"blitzcrank/internal/store"
)

func TestThreadHistorySearchFindsPriorTraceSnippets(t *testing.T) {
	root := t.TempDir()
	writeTrace(t, filepath.Join(root, "discord", "123.jsonl"), map[string]any{
		"type":                "discord_event",
		"thread_id":           "discord:123",
		"title":               "Import hängt",
		"source_message_text": "Der stale import fuer Example Show haengt schon wieder.",
		"created_at":          "2026-05-20T10:00:00Z",
	})
	writeTrace(t, filepath.Join(root, "issues", "issue-42.jsonl"), map[string]any{
		"type":          "agent_run",
		"issue":         "42",
		"final_comment": "Example Show war wegen eines stale import blockiert und wurde bereinigt.",
		"completed_at":  "2026-05-20T11:00:00Z",
	})

	registry := NewRegistry(config.Config{ThreadsDirectory: root})
	out, err := registry.Call(context.Background(), "thread_history_search", map[string]any{
		"query": "Example Show stale import",
		"limit": float64(2),
	})
	if err != nil {
		t.Fatalf("thread_history_search error = %v", err)
	}
	result := out.(threadHistorySearchResult)
	if result.SearchedFiles != 2 || result.MatchedThreads != 2 || len(result.Matches) != 2 {
		t.Fatalf("result = %#v, want two matched traces", result)
	}
	if result.Matches[0].Score < result.Matches[1].Score {
		t.Fatalf("matches not sorted by score: %#v", result.Matches)
	}
	if result.Matches[0].Snippets[0].Text == "" || !strings.Contains(result.Matches[0].Snippets[0].Text, "Example Show") {
		t.Fatalf("snippet = %#v, want compact matching text", result.Matches[0].Snippets)
	}
}

func TestThreadHistorySearchExcludesCurrentThread(t *testing.T) {
	root := t.TempDir()
	writeTrace(t, filepath.Join(root, "discord", "current.jsonl"), map[string]any{
		"type":       "discord_event",
		"message":    "Project Hail Mary aktuelle Frage",
		"created_at": time.Now().UTC().Format(time.RFC3339Nano),
	})
	writeTrace(t, filepath.Join(root, "discord", "older.jsonl"), map[string]any{
		"type":       "discord_event",
		"message":    "Project Hail Mary wurde schon einmal geprueft.",
		"created_at": time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano),
	})

	registry := NewRegistry(config.Config{ThreadsDirectory: root})
	out, err := registry.Call(context.Background(), "thread_history_search", map[string]any{
		"query":             "Project Hail Mary",
		"source":            "discord",
		"exclude_thread_id": "discord:current",
	})
	if err != nil {
		t.Fatalf("thread_history_search error = %v", err)
	}
	result := out.(threadHistorySearchResult)
	if len(result.Matches) != 1 || result.Matches[0].ThreadID != "discord:older" {
		t.Fatalf("matches = %#v, want only older thread", result.Matches)
	}
}

func TestThreadHistorySearchAcceptsSourceAliases(t *testing.T) {
	root := t.TempDir()
	writeTrace(t, filepath.Join(root, "automations", "hourly-stale-import-handler.jsonl"), map[string]any{
		"type":      "automation_run",
		"result":    "MANUAL_INTERVENTION_REQUIRED Radarr Example Movie stale import",
		"completed": "2026-05-20T10:00:00Z",
	})

	registry := NewRegistry(config.Config{ThreadsDirectory: root})
	out, err := registry.Call(context.Background(), "thread_history_search", map[string]any{
		"query":  "Example Movie stale import",
		"source": "automation",
	})
	if err != nil {
		t.Fatalf("thread_history_search error = %v", err)
	}
	result := out.(threadHistorySearchResult)
	if result.Source != "automations" || len(result.Matches) != 1 || result.Matches[0].Source != "automations" {
		t.Fatalf("result = %#v, want automation alias normalized to automations", result)
	}
}

func TestThreadHistorySearchSnippetsIncludeToolOutcomeSummaries(t *testing.T) {
	root := t.TempDir()
	writeTrace(t, filepath.Join(root, "issues", "issue-7.jsonl"), map[string]any{
		"type":           "tool_call",
		"tool_name":      "sonarr_request",
		"result_summary": "Sonarr history showed Example Show S01E02 was blocklisted after an import rejection.",
		"completed_at":   "2026-05-20T10:00:00Z",
	})

	registry := NewRegistry(config.Config{ThreadsDirectory: root})
	out, err := registry.Call(context.Background(), "thread_history_search", map[string]any{
		"query":  "Example Show blocklisted",
		"source": "seerr_issue",
	})
	if err != nil {
		t.Fatalf("thread_history_search error = %v", err)
	}
	result := out.(threadHistorySearchResult)
	if result.Source != "issues" || len(result.Matches) != 1 {
		t.Fatalf("result = %#v, want seerr_issue alias and one match", result)
	}
	text := result.Matches[0].Snippets[0].Text
	if !strings.Contains(text, "sonarr_request") || !strings.Contains(text, "blocklisted") {
		t.Fatalf("snippet = %q, want tool name and result summary", text)
	}
}

func writeTrace(t *testing.T, path string, value any) {
	t.Helper()
	if err := store.AppendJSONL(path, value); err != nil {
		t.Fatal(err)
	}
}
