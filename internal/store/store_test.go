package store

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"sync"
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

	now := time.Now().UTC().Truncate(time.Second)
	completed := now.Add(time.Minute)
	thread := IssueThread{
		IssueID:         "42",
		Status:          "active",
		Summary:         "Example issue",
		CreatedAt:       now,
		UpdatedAt:       now,
		LastPayloadJSON: `{"issue_id":"42"}`,
	}
	if err := store.UpsertIssueThread(ctx, thread); err != nil {
		t.Fatalf("UpsertIssueThread() error = %v", err)
	}
	if err := store.InsertIssueEvent(ctx, IssueEvent{
		IssueID:     "42",
		EventKey:    "event-1",
		EventType:   "reported",
		Actor:       "alice",
		PayloadJSON: `{"message":"broken"}`,
		CreatedAt:   now,
	}); err != nil {
		t.Fatalf("InsertIssueEvent() error = %v", err)
	}
	if err := store.InsertIssueRun(ctx, IssueRun{
		IssueID:          "42",
		SourceEventType:  "reported",
		StartedAt:        now,
		CompletedAt:      &completed,
		Posted:           true,
		Attribution:      "seerr:gpt",
		CompletionReason: "posted",
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
	if loaded.IssueID != "42" || loaded.Summary != "Example issue" || len(loaded.Events) != 1 || len(loaded.Runs) != 1 {
		t.Fatalf("loaded = %#v", loaded)
	}
	if loaded.Events[0].EventKey != "event-1" || loaded.Events[0].EventType != "reported" {
		t.Fatalf("event = %#v", loaded.Events[0])
	}
	if !loaded.Runs[0].Posted || loaded.Runs[0].CompletionReason != "posted" {
		t.Fatalf("run = %#v", loaded.Runs[0])
	}
}

func TestIssueThreadRevisitFields(t *testing.T) {
	t.Run("upsert and load round trips schedule", func(t *testing.T) {
		ctx := context.Background()
		store, err := Open(ctx, filepath.Join(t.TempDir(), "state.sqlite"))
		if err != nil {
			t.Fatalf("Open() error = %v", err)
		}
		defer store.Close()

		now := time.Now().UTC().Truncate(time.Second)
		nextRevisitAt := now.Add(45 * time.Minute)
		if err := store.UpsertIssueThread(ctx, IssueThread{
			IssueID:       "42",
			Status:        "active",
			Summary:       "Example issue",
			CreatedAt:     now,
			UpdatedAt:     now,
			NextRevisitAt: &nextRevisitAt,
			RevisitReason: "verify encode finished",
		}); err != nil {
			t.Fatalf("UpsertIssueThread() error = %v", err)
		}

		loaded, ok, err := store.LoadIssueThread(ctx, "42")
		if err != nil {
			t.Fatalf("LoadIssueThread() error = %v", err)
		}
		if !ok {
			t.Fatal("LoadIssueThread() ok = false")
		}
		if loaded.NextRevisitAt == nil {
			t.Fatal("NextRevisitAt = nil, want persisted time")
		}
		if !loaded.NextRevisitAt.Equal(nextRevisitAt) {
			t.Fatalf("NextRevisitAt = %s, want %s", loaded.NextRevisitAt, nextRevisitAt)
		}
		if loaded.RevisitReason != "verify encode finished" {
			t.Fatalf("RevisitReason = %q, want verify encode finished", loaded.RevisitReason)
		}
	})

	t.Run("migration adds schedule columns to old schema", func(t *testing.T) {
		ctx := context.Background()
		path := filepath.Join(t.TempDir(), "state.sqlite")
		db, err := sql.Open("sqlite", sqliteDSN(path))
		if err != nil {
			t.Fatalf("sql.Open() error = %v", err)
		}
		_, err = db.ExecContext(ctx, `
CREATE TABLE issue_threads (
  issue_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  completion_reason TEXT,
  last_payload_json TEXT
);`)
		if err != nil {
			_ = db.Close()
			t.Fatalf("create old issue_threads schema: %v", err)
		}
		if err := db.Close(); err != nil {
			t.Fatalf("close raw db: %v", err)
		}

		store, err := Open(ctx, path)
		if err != nil {
			t.Fatalf("Open() with old schema error = %v", err)
		}
		defer store.Close()

		now := time.Now().UTC().Truncate(time.Second)
		nextRevisitAt := now.Add(time.Hour)
		if err := store.UpsertIssueThread(ctx, IssueThread{
			IssueID:       "43",
			Status:        "active",
			CreatedAt:     now,
			UpdatedAt:     now,
			NextRevisitAt: &nextRevisitAt,
			RevisitReason: "old database migrated",
		}); err != nil {
			t.Fatalf("UpsertIssueThread() after migration error = %v", err)
		}

		loaded, ok, err := store.LoadIssueThread(ctx, "43")
		if err != nil {
			t.Fatalf("LoadIssueThread() after migration error = %v", err)
		}
		if !ok {
			t.Fatal("LoadIssueThread() after migration ok = false")
		}
		if loaded.NextRevisitAt == nil {
			t.Fatal("NextRevisitAt after migration = nil, want persisted time")
		}
		if !loaded.NextRevisitAt.Equal(nextRevisitAt) {
			t.Fatalf("NextRevisitAt after migration = %s, want %s", loaded.NextRevisitAt, nextRevisitAt)
		}
		if loaded.RevisitReason != "old database migrated" {
			t.Fatalf("RevisitReason after migration = %q, want old database migrated", loaded.RevisitReason)
		}
	})
}

func TestIssueEventKeyIsUniquePerIssue(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer store.Close()
	now := time.Now().UTC()
	for _, issueID := range []string{"1", "2"} {
		if err := store.UpsertIssueThread(ctx, IssueThread{IssueID: issueID, Status: "active", CreatedAt: now, UpdatedAt: now}); err != nil {
			t.Fatalf("UpsertIssueThread(%s) error = %v", issueID, err)
		}
		if err := store.InsertIssueEvent(ctx, IssueEvent{IssueID: issueID, EventKey: "same", EventType: "reported", PayloadJSON: `{}`, CreatedAt: now}); err != nil {
			t.Fatalf("InsertIssueEvent(%s) error = %v", issueID, err)
		}
	}
	if err := store.InsertIssueEvent(ctx, IssueEvent{IssueID: "1", EventKey: "same", EventType: "reported", PayloadJSON: `{}`, CreatedAt: now}); err == nil {
		t.Fatal("duplicate InsertIssueEvent error = nil, want unique constraint")
	}
}

func TestStoreConcurrentWritesDoNotFail(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer store.Close()

	now := time.Now().UTC().Truncate(time.Second)
	if err := store.UpsertIssueThread(ctx, IssueThread{
		IssueID:   "concurrent",
		Status:    "active",
		CreatedAt: now,
		UpdatedAt: now,
	}); err != nil {
		t.Fatalf("UpsertIssueThread() error = %v", err)
	}

	const goroutines = 20
	var wg sync.WaitGroup
	errCh := make(chan error, goroutines*2)
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := store.InsertIssueEvent(ctx, IssueEvent{
				IssueID:     "concurrent",
				EventKey:    fmt.Sprintf("event-%d", i),
				EventType:   "reported",
				PayloadJSON: `{}`,
				CreatedAt:   now,
			}); err != nil {
				errCh <- fmt.Errorf("InsertIssueEvent(%d): %w", i, err)
				return
			}
			if err := store.InsertIssueRun(ctx, IssueRun{
				IssueID:         "concurrent",
				SourceEventType: fmt.Sprintf("run-%d", i),
				StartedAt:       now,
			}); err != nil {
				errCh <- fmt.Errorf("InsertIssueRun(%d): %w", i, err)
			}
		}(i)
	}
	wg.Wait()
	close(errCh)

	for err := range errCh {
		t.Errorf("concurrent write error: %v", err)
	}
}

func TestLoadIssueRunsReturnsInvalidCompletedAtError(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer store.Close()
	now := time.Now().UTC()
	if err := store.UpsertIssueThread(ctx, IssueThread{IssueID: "1", Status: "active", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatalf("UpsertIssueThread() error = %v", err)
	}
	_, err = store.db.ExecContext(ctx, `INSERT INTO issue_runs(issue_id,source_event_type,started_at,completed_at,posted,attribution,error,completion_reason) VALUES(?,?,?,?,?,?,?,?)`, "1", "reported", formatTime(now), "not-a-time", 0, "", "", "")
	if err != nil {
		t.Fatalf("insert malformed issue_run error = %v", err)
	}
	_, err = store.LoadIssueRuns(ctx, "1")
	if err == nil {
		t.Fatal("LoadIssueRuns() error = nil, want timestamp parse error")
	}
}
