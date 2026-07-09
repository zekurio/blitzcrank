package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestDiscordConversationPersistenceAndRecovery(t *testing.T) {
	ctx := context.Background()
	state, err := Open(ctx, filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()

	now := time.Now().UTC().Truncate(time.Second)
	conversations := []DiscordConversation{
		{
			ThreadID:         "thread-later",
			ParentChannelID:  "channel-1",
			OwnerID:          "owner-1",
			TriggerMessageID: "message-1",
			Route:            "private_thread",
			Category:         "local_lookup",
			Status:           DiscordConversationActive,
			CreatedAt:        now,
			UpdatedAt:        now.Add(time.Minute),
		},
		{
			ThreadID:         "thread-earlier",
			ParentChannelID:  "channel-1",
			OwnerID:          "owner-2",
			TriggerMessageID: "message-2",
			Route:            "private_thread",
			Category:         "diagnosis",
			Status:           DiscordConversationActive,
			CreatedAt:        now,
			UpdatedAt:        now,
		},
		{
			ThreadID:         "thread-archived",
			ParentChannelID:  "channel-1",
			OwnerID:          "owner-3",
			TriggerMessageID: "message-3",
			Route:            "private_thread",
			Category:         "diagnosis",
			Status:           DiscordConversationArchived,
			CreatedAt:        now,
			UpdatedAt:        now,
		},
	}
	for _, conversation := range conversations {
		if err := state.UpsertDiscordConversation(ctx, conversation); err != nil {
			t.Fatalf("UpsertDiscordConversation(%q) error = %v", conversation.ThreadID, err)
		}
	}

	loaded, ok, err := state.LoadDiscordConversation(ctx, "thread-later")
	if err != nil {
		t.Fatalf("LoadDiscordConversation() error = %v", err)
	}
	if !ok {
		t.Fatal("LoadDiscordConversation() ok = false")
	}
	if loaded.OwnerID != "owner-1" || loaded.Route != "private_thread" || loaded.Category != "local_lookup" {
		t.Fatalf("LoadDiscordConversation() = %#v", loaded)
	}

	recoverable, err := state.ListRecoverableDiscordConversations(ctx)
	if err != nil {
		t.Fatalf("ListRecoverableDiscordConversations() error = %v", err)
	}
	var gotIDs []string
	for _, conversation := range recoverable {
		gotIDs = append(gotIDs, conversation.ThreadID)
	}
	if want := []string{"thread-earlier", "thread-later"}; !slices.Equal(gotIDs, want) {
		t.Fatalf("recoverable IDs = %#v, want %#v", gotIDs, want)
	}
}

func TestClaimDiscordMessageIsAtomicAndDurable(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "state.sqlite")
	state, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}

	message := DiscordMessage{
		MessageID:  "message-1",
		ChannelID:  "channel-1",
		AuthorID:   "owner-1",
		ReceivedAt: time.Now().UTC(),
	}
	const claimers = 20
	var claims atomic.Int64
	var wg sync.WaitGroup
	errCh := make(chan error, claimers)
	for range claimers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			claimed, err := state.ClaimDiscordMessage(ctx, message)
			if err != nil {
				errCh <- err
				return
			}
			if claimed {
				claims.Add(1)
			}
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Errorf("ClaimDiscordMessage() error = %v", err)
	}
	if got := claims.Load(); got != 1 {
		t.Fatalf("successful claims = %d, want 1", got)
	}
	if err := state.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	state, err = Open(ctx, path)
	if err != nil {
		t.Fatalf("Open() after restart error = %v", err)
	}
	defer state.Close()
	claimed, err := state.ClaimDiscordMessage(ctx, message)
	if err != nil {
		t.Fatalf("ClaimDiscordMessage() after restart error = %v", err)
	}
	if claimed {
		t.Fatal("ClaimDiscordMessage() after restart = true, want durable duplicate rejection")
	}
}

func TestDiscordRunRecoveryAndCompletion(t *testing.T) {
	ctx := context.Background()
	state, err := Open(ctx, filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()

	now := time.Now().UTC().Truncate(time.Second)
	for _, id := range []string{"message-1", "message-2"} {
		claimed, err := state.ClaimDiscordMessage(ctx, DiscordMessage{MessageID: id, ChannelID: "channel-1", AuthorID: "owner-1", ReceivedAt: now})
		if err != nil || !claimed {
			t.Fatalf("ClaimDiscordMessage(%q) = %v, %v", id, claimed, err)
		}
	}
	runs := []DiscordRun{
		{ID: "run-later", MessageID: "message-1", ThreadID: "thread-1", Source: "discord_thread", ActorID: "owner-1", Route: "private_thread", Category: "diagnosis", StartedAt: now.Add(time.Minute)},
		{ID: "run-earlier", MessageID: "message-2", ThreadID: "thread-1", Source: "discord_thread", ActorID: "owner-1", Route: "private_thread", Category: "diagnosis", StartedAt: now},
	}
	for _, run := range runs {
		if err := state.StartDiscordRun(ctx, run); err != nil {
			t.Fatalf("StartDiscordRun(%q) error = %v", run.ID, err)
		}
	}
	if err := state.StartDiscordRun(ctx, runs[0]); err == nil {
		t.Fatal("duplicate StartDiscordRun() error = nil, want run ID deduplication")
	}

	recoverable, err := state.ListRecoverableDiscordRuns(ctx)
	if err != nil {
		t.Fatalf("ListRecoverableDiscordRuns() error = %v", err)
	}
	var gotIDs []string
	for _, run := range recoverable {
		gotIDs = append(gotIDs, run.ID)
	}
	if want := []string{"run-earlier", "run-later"}; !slices.Equal(gotIDs, want) {
		t.Fatalf("recoverable run IDs = %#v, want %#v", gotIDs, want)
	}

	completedAt := now.Add(2 * time.Minute)
	longError := strings.Repeat("x", 700)
	if err := state.CompleteDiscordRun(ctx, "run-earlier", "failed", longError, completedAt); err != nil {
		t.Fatalf("CompleteDiscordRun() error = %v", err)
	}
	recoverable, err = state.ListRecoverableDiscordRuns(ctx)
	if err != nil {
		t.Fatalf("ListRecoverableDiscordRuns() after completion error = %v", err)
	}
	if len(recoverable) != 1 || recoverable[0].ID != "run-later" {
		t.Fatalf("recoverable runs after completion = %#v", recoverable)
	}
	message, ok, err := state.LoadDiscordMessage(ctx, "message-2")
	if err != nil || !ok {
		t.Fatalf("LoadDiscordMessage() = %#v, %v, %v", message, ok, err)
	}
	if message.Status != "failed" || message.CompletedAt == nil || len([]rune(message.Error)) != 512 {
		t.Fatalf("completed message = %#v", message)
	}
}

func TestListRecoverableDiscordMessagesReturnsUnstartedClaimsInOrder(t *testing.T) {
	ctx := context.Background()
	state, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()
	now := time.Now().UTC().Truncate(time.Second)
	for _, message := range []DiscordMessage{
		{MessageID: "later", ChannelID: "channel", AuthorID: "owner", ReceivedAt: now.Add(time.Second)},
		{MessageID: "earlier", ChannelID: "channel", AuthorID: "owner", ReceivedAt: now},
		{MessageID: "done", ChannelID: "channel", AuthorID: "owner", ReceivedAt: now.Add(-time.Second)},
	} {
		claimed, err := state.ClaimDiscordMessage(ctx, message)
		if err != nil || !claimed {
			t.Fatalf("ClaimDiscordMessage(%q) = %t, %v", message.MessageID, claimed, err)
		}
	}
	if err := state.CompleteDiscordMessage(ctx, "done", "completed", "", now); err != nil {
		t.Fatal(err)
	}
	messages, err := state.ListRecoverableDiscordMessages(ctx)
	if err != nil {
		t.Fatalf("ListRecoverableDiscordMessages() error = %v", err)
	}
	if len(messages) != 2 || messages[0].MessageID != "earlier" || messages[1].MessageID != "later" {
		t.Fatalf("recoverable messages = %#v", messages)
	}
}

func TestDiscordSchemaMigratesFromIssueOnlyDatabase(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "state.sqlite")
	db, err := sql.Open("sqlite", sqliteDSN(path))
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	if _, err := db.ExecContext(ctx, `
CREATE TABLE issue_threads (
  issue_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  completion_reason TEXT,
  last_payload_json TEXT
);`); err != nil {
		_ = db.Close()
		t.Fatalf("create legacy database: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close legacy database: %v", err)
	}

	state, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("Open() legacy database error = %v", err)
	}
	defer state.Close()
	claimed, err := state.ClaimDiscordMessage(ctx, DiscordMessage{MessageID: "message-1", ChannelID: "channel-1", AuthorID: "owner-1", ReceivedAt: time.Now().UTC()})
	if err != nil || !claimed {
		t.Fatalf("ClaimDiscordMessage() after migration = %v, %v", claimed, err)
	}
}

func TestPruneDiscordStateKeepsInterruptedRunsAndActiveConversations(t *testing.T) {
	ctx := context.Background()
	state, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()

	now := time.Now().UTC().Truncate(time.Second)
	old := now.Add(-48 * time.Hour)
	if err := state.UpsertDiscordConversation(ctx, DiscordConversation{
		ThreadID: "old-thread", OwnerID: "owner-1", Status: DiscordConversationActive, CreatedAt: old, UpdatedAt: old,
	}); err != nil {
		t.Fatalf("UpsertDiscordConversation() error = %v", err)
	}
	for _, id := range []string{"completed-message", "interrupted-message"} {
		claimed, err := state.ClaimDiscordMessage(ctx, DiscordMessage{MessageID: id, ChannelID: "channel-1", AuthorID: "owner-1", ReceivedAt: old})
		if err != nil || !claimed {
			t.Fatalf("ClaimDiscordMessage(%q) = %v, %v", id, claimed, err)
		}
	}
	if err := state.CompleteDiscordMessage(ctx, "completed-message", "completed", "", old); err != nil {
		t.Fatalf("CompleteDiscordMessage() error = %v", err)
	}
	if err := state.StartDiscordRun(ctx, DiscordRun{ID: "interrupted-run", MessageID: "interrupted-message", Source: "discord_direct", ActorID: "owner-1", Status: DiscordRunRunning, StartedAt: old}); err != nil {
		t.Fatalf("StartDiscordRun() error = %v", err)
	}
	// A message can be terminal while its run remains recoverable after a
	// process interruption between the two persistence updates.
	if err := state.CompleteDiscordMessage(ctx, "interrupted-message", "failed", "interrupted", old); err != nil {
		t.Fatalf("CompleteDiscordMessage(interrupted) error = %v", err)
	}

	if err := state.PruneDiscordState(ctx, now.Add(-24*time.Hour)); err != nil {
		t.Fatalf("PruneDiscordState() error = %v", err)
	}
	if _, ok, err := state.LoadDiscordConversation(ctx, "old-thread"); err != nil || !ok {
		t.Fatalf("LoadDiscordConversation(old active) = ok %v, err %v; want retained", ok, err)
	}
	if _, ok, err := state.LoadDiscordMessage(ctx, "completed-message"); err != nil || ok {
		t.Fatalf("LoadDiscordMessage(completed) = ok %v, err %v; want pruned", ok, err)
	}
	if _, ok, err := state.LoadDiscordMessage(ctx, "interrupted-message"); err != nil || !ok {
		t.Fatalf("LoadDiscordMessage(interrupted) = ok %v, err %v; want retained", ok, err)
	}
	runs, err := state.ListRecoverableDiscordRuns(ctx)
	if err != nil || len(runs) != 1 || runs[0].ID != "interrupted-run" {
		t.Fatalf("ListRecoverableDiscordRuns() = %#v, %v", runs, err)
	}
}

func TestDiscordTablesDoNotHaveMessageContentColumns(t *testing.T) {
	ctx := context.Background()
	state, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()

	for _, table := range []string{"discord_conversations", "discord_messages", "discord_runs"} {
		rows, err := state.db.QueryContext(ctx, `SELECT name FROM pragma_table_info(?)`, table)
		if err != nil {
			t.Fatalf("inspect %s: %v", table, err)
		}
		for rows.Next() {
			var column string
			if err := rows.Scan(&column); err != nil {
				_ = rows.Close()
				t.Fatalf("scan %s column: %v", table, err)
			}
			lower := strings.ToLower(column)
			if strings.Contains(lower, "content") || strings.Contains(lower, "body") || strings.Contains(lower, "response") {
				_ = rows.Close()
				t.Fatalf("%s unexpectedly has private-content column %q", table, column)
			}
		}
		if err := rows.Close(); err != nil {
			t.Fatalf("close %s schema rows: %v", table, err)
		}
	}
}
