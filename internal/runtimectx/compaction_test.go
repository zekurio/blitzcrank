package runtimectx

import (
	"path/filepath"
	"testing"
	"time"
)

func TestCompactionLedgerRoundTripAndLimit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "compactions.jsonl")
	now := time.Date(2026, 5, 19, 10, 0, 0, 0, time.UTC)
	entries := []CompactionEntry{
		NewCompactionEntry(NewCompactionEntryOptions{Summary: "first", FirstKeptEntryID: "event:1", TokensBefore: 100, Now: now}),
		NewCompactionEntry(NewCompactionEntryOptions{ParentID: "p", Summary: "second", FirstKeptEntryID: "event:2", TokensBefore: 50, Details: map[string]any{"component": "transcript"}, Now: now.Add(time.Second)}),
	}
	if err := AppendCompactionEntries(path, entries); err != nil {
		t.Fatalf("AppendCompactionEntries() error = %v", err)
	}
	loaded, err := ReadCompactionEntries(path, 1)
	if err != nil {
		t.Fatalf("ReadCompactionEntries() error = %v", err)
	}
	if len(loaded) != 1 || loaded[0].Summary != "second" || loaded[0].Details["component"] != "transcript" {
		t.Fatalf("loaded entries = %#v", loaded)
	}
}

func TestLayerTokenEstimates(t *testing.T) {
	layers := []Layer{
		{Key: "system", Content: "12345", Budget: LayerBudgetProtected},
		{Key: "history", Content: "12345678", Budget: LayerBudgetCompress},
	}
	if got := TotalLayerTokens(layers); got != 4 {
		t.Fatalf("TotalLayerTokens() = %d, want 4", got)
	}
	estimates := EstimateLayerTokens(layers)
	if len(estimates) != 2 || estimates[0].Tokens != 2 || estimates[1].Tokens != 2 {
		t.Fatalf("EstimateLayerTokens() = %#v", estimates)
	}
}
