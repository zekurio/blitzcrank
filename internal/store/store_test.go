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
		Summary:         "User reports a missing episode.",
		CreatedAt:       now,
		UpdatedAt:       now,
		LastPayloadJSON: `{"ok":true}`,
	}
	if err := store.UpsertIssueThread(ctx, thread); err != nil {
		t.Fatalf("UpsertIssueThread() error = %v", err)
	}
	if err := store.InsertIssueEvent(ctx, IssueEvent{
		IssueID:     "42",
		EventKey:    "event-1",
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
	if err := store.InsertIssueToolCall(ctx, IssueToolCall{
		IssueID:          "42",
		SourceEventType:  "reported",
		RunStartedAt:     now,
		ToolName:         "seerr_get_issue",
		ArgumentsSummary: `{"issue_id":"42"}`,
		ResultSummary:    `{"id":42}`,
		StartedAt:        now,
		CompletedAt:      completed,
	}); err != nil {
		t.Fatalf("InsertIssueToolCall() error = %v", err)
	}

	loaded, ok, err := store.LoadIssueThread(ctx, "42")
	if err != nil {
		t.Fatalf("LoadIssueThread() error = %v", err)
	}
	if !ok {
		t.Fatal("LoadIssueThread() ok = false")
	}
	if loaded.Summary != "User reports a missing episode." {
		t.Fatalf("summary = %q", loaded.Summary)
	}
	if len(loaded.Events) != 1 || loaded.Events[0].EventType != "reported" || loaded.Events[0].EventKey != "event-1" {
		t.Fatalf("events = %#v", loaded.Events)
	}
	if len(loaded.Runs) != 1 || !loaded.Runs[0].Posted {
		t.Fatalf("runs = %#v", loaded.Runs)
	}
	calls, err := store.LoadIssueToolCalls(ctx, "42")
	if err != nil {
		t.Fatalf("LoadIssueToolCalls() error = %v", err)
	}
	if len(calls) != 1 || calls[0].ToolName != "seerr_get_issue" {
		t.Fatalf("tool calls = %#v", calls)
	}
}

func TestStorePersistsAgentThreadEventAndRun(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer store.Close()

	now := time.Now().UTC()
	thread := AgentThread{
		ThreadID:         "discord:thread-1",
		Source:           "discord",
		ExternalID:       "thread-1",
		ParentExternalID: "channel-1",
		RootExternalID:   "message-1",
		Status:           "active",
		Title:            "Missing episode",
		Summary:          "User reports a missing episode.",
		CreatedAt:        now,
		UpdatedAt:        now,
		LastPayloadJSON:  `{"ok":true}`,
	}
	if err := store.UpsertAgentThread(ctx, thread); err != nil {
		t.Fatalf("UpsertAgentThread() error = %v", err)
	}
	if err := store.InsertAgentThreadEvent(ctx, AgentThreadEvent{
		ThreadID:          "discord:thread-1",
		EventType:         "root_message",
		Actor:             "alice",
		ActorID:           "user-1",
		Message:           "episode is missing",
		ExternalMessageID: "message-1",
		PayloadJSON:       `{"message_id":"message-1"}`,
		CreatedAt:         now,
	}); err != nil {
		t.Fatalf("InsertAgentThreadEvent() error = %v", err)
	}
	completed := now.Add(time.Second)
	if err := store.InsertAgentRun(ctx, AgentRun{
		ThreadID:         "discord:thread-1",
		SourceEventType:  "root_message",
		StartedAt:        now,
		CompletedAt:      &completed,
		FinalResponse:    "done",
		Posted:           true,
		Attribution:      "discord:gpt-5.5",
		CompletionReason: "discord response posted",
		Summary:          "Resolved.",
	}); err != nil {
		t.Fatalf("InsertAgentRun() error = %v", err)
	}

	loaded, ok, err := store.LoadAgentThreadByExternalID(ctx, "discord", "thread-1")
	if err != nil {
		t.Fatalf("LoadAgentThreadByExternalID() error = %v", err)
	}
	if !ok {
		t.Fatal("LoadAgentThreadByExternalID() ok = false")
	}
	if loaded.ThreadID != "discord:thread-1" || loaded.ParentExternalID != "channel-1" || loaded.RootExternalID != "message-1" {
		t.Fatalf("loaded thread = %#v", loaded)
	}
	if len(loaded.Events) != 1 || loaded.Events[0].ExternalMessageID != "message-1" {
		t.Fatalf("events = %#v", loaded.Events)
	}
	if len(loaded.Runs) != 1 || !loaded.Runs[0].Posted || loaded.Runs[0].Summary != "Resolved." {
		t.Fatalf("runs = %#v", loaded.Runs)
	}
}

func TestAppendJSONL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "trace", "run.jsonl")
	if err := AppendJSONL(path, map[string]any{"type": "test"}); err != nil {
		t.Fatalf("AppendJSONL() error = %v", err)
	}
}
