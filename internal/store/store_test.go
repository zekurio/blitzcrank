package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestStorePersistsIssueThreadEventAndRun(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer store.Close()

	now := time.Now().UTC()
	thread := IssueThread{
		IssueID:         "42",
		Status:          "active",
		CreatedAt:       now,
		UpdatedAt:       now,
		LastPayloadJSON: `{"ok":true}`,
	}
	if err := store.UpsertIssueThread(ctx, thread); err != nil {
		t.Fatalf("UpsertIssueThread() error = %v", err)
	}
	if err := store.InsertIssueEvent(ctx, IssueEvent{
		IssueID:     "42",
		EventType:   "reported",
		Actor:       "alice",
		Message:     "missing episode",
		PayloadJSON: `{"issue":{"issue_id":"42"}}`,
		CreatedAt:   now,
	}); err != nil {
		t.Fatalf("InsertIssueEvent() error = %v", err)
	}
	completed := now.Add(time.Second)
	if err := store.InsertIssueRun(ctx, IssueRun{
		IssueID:          "42",
		SourceEventType:  "reported",
		StartedAt:        now,
		CompletedAt:      &completed,
		FinalComment:     "done",
		Posted:           true,
		Attribution:      "signed:Blitzcrank",
		CompletionReason: "final comment posted",
	}); err != nil {
		t.Fatalf("InsertIssueRun() error = %v", err)
	}

	loaded, ok, err := store.LoadIssueThread(ctx, "42")
	if err != nil {
		t.Fatalf("LoadIssueThread() error = %v", err)
	}
	if !ok {
		t.Fatal("LoadIssueThread() ok = false")
	}
	if len(loaded.Events) != 1 || loaded.Events[0].EventType != "reported" {
		t.Fatalf("events = %#v", loaded.Events)
	}
	if len(loaded.Runs) != 1 || !loaded.Runs[0].Posted {
		t.Fatalf("runs = %#v", loaded.Runs)
	}
}

func TestAppendJSONL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "trace", "run.jsonl")
	if err := AppendJSONL(path, map[string]any{"type": "test"}); err != nil {
		t.Fatalf("AppendJSONL() error = %v", err)
	}
}
