package store

import (
	"context"
	"path/filepath"
	"strings"
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
	if len(loaded.Runs) != 1 || !loaded.Runs[0].Posted {
		t.Fatalf("runs = %#v", loaded.Runs)
	}
	if loaded.Runs[0].Summary != "Resolved." {
		t.Fatalf("run summary = %q, want Resolved.", loaded.Runs[0].Summary)
	}
}

func TestLoadAgentThreadByBotMessageIDUsesPayloadAliases(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer store.Close()

	now := time.Now().UTC()
	thread := AgentThread{
		ThreadID:        "discord:bot-message-1",
		Source:          "discord",
		ExternalID:      "bot-message-2",
		Status:          "active",
		Title:           "Support",
		CreatedAt:       now,
		UpdatedAt:       now,
		LastPayloadJSON: `{"bot_message_id":"bot-message-1","latest_bot_message_id":"bot-message-2","bot_message_ids":["bot-message-1","bot-message-2"]}`,
	}
	if err := store.UpsertAgentThread(ctx, thread); err != nil {
		t.Fatalf("UpsertAgentThread() error = %v", err)
	}

	loaded, ok, err := store.LoadAgentThreadByBotMessageID(ctx, "discord", "bot-message-1")
	if err != nil {
		t.Fatalf("LoadAgentThreadByBotMessageID() error = %v", err)
	}
	if !ok {
		t.Fatal("LoadAgentThreadByBotMessageID() ok = false")
	}
	if loaded.ThreadID != thread.ThreadID {
		t.Fatalf("ThreadID = %q, want %q", loaded.ThreadID, thread.ThreadID)
	}

	loaded, ok, err = store.LoadAgentThreadByBotMessageID(ctx, "discord", "bot-message-2")
	if err != nil {
		t.Fatalf("LoadAgentThreadByBotMessageID(latest) error = %v", err)
	}
	if !ok || loaded.ThreadID != thread.ThreadID {
		t.Fatalf("latest lookup = %#v, ok=%v", loaded, ok)
	}
}

func TestStoreEnforcesForeignKeysAcrossConnections(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer store.Close()
	store.db.SetMaxOpenConns(4)
	store.db.SetMaxIdleConns(0)

	for i := 0; i < 8; i++ {
		err := store.InsertAgentThreadEvent(ctx, AgentThreadEvent{
			ThreadID:    "missing-thread",
			EventType:   "message",
			PayloadJSON: "{}",
			CreatedAt:   time.Now().UTC(),
		})
		if err == nil {
			t.Fatalf("InsertAgentThreadEvent() attempt %d error = nil, want foreign key constraint", i)
		}
		if !strings.Contains(strings.ToLower(err.Error()), "constraint") {
			t.Fatalf("InsertAgentThreadEvent() attempt %d error = %v, want constraint error", i, err)
		}
	}
}

func TestLoadAgentRunsReturnsInvalidCompletedAtError(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer store.Close()

	now := time.Now().UTC()
	if err := store.UpsertAgentThread(ctx, AgentThread{
		ThreadID:   "thread-1",
		Source:     "discord",
		ExternalID: "thread-1",
		Status:     "active",
		CreatedAt:  now,
		UpdatedAt:  now,
	}); err != nil {
		t.Fatalf("UpsertAgentThread() error = %v", err)
	}
	_, err = store.db.ExecContext(ctx, `INSERT INTO agent_runs(thread_id,source_event_type,started_at,completed_at,final_response,attribution,error,completion_reason,summary) VALUES(?,?,?,?,?,?,?,?,?)`, "thread-1", "message", formatTime(now), "not-a-time", "", "", "", "", "")
	if err != nil {
		t.Fatalf("insert malformed run: %v", err)
	}
	_, err = store.LoadAgentRuns(ctx, "thread-1")
	if err == nil {
		t.Fatal("LoadAgentRuns() error = nil, want timestamp parse error")
	}
	if !strings.Contains(err.Error(), `cannot parse`) {
		t.Fatalf("LoadAgentRuns() error = %v, want parse error", err)
	}
}

func TestAppendJSONL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "trace", "run.jsonl")
	if err := AppendJSONL(path, map[string]any{"type": "test"}); err != nil {
		t.Fatalf("AppendJSONL() error = %v", err)
	}
}
