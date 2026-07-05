package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	db *sql.DB
}

type IssueThread struct {
	IssueID          string
	Status           string
	Summary          string
	CreatedAt        time.Time
	UpdatedAt        time.Time
	CompletedAt      *time.Time
	CompletionReason string
	NextRevisitAt    *time.Time
	RevisitReason    string
	LastPayloadJSON  string
	Events           []IssueEvent
	Runs             []IssueRun
}

type IssueEvent struct {
	ID          int64
	IssueID     string
	EventKey    string
	EventType   string
	Actor       string
	Message     string
	PayloadJSON string
	CreatedAt   time.Time
}

type IssueRun struct {
	ID               int64
	IssueID          string
	SourceEventType  string
	StartedAt        time.Time
	CompletedAt      *time.Time
	FinalComment     string
	Posted           bool
	Attribution      string
	Error            string
	CompletionReason string
}

func Open(ctx context.Context, path string) (*Store, error) {
	if path == "" {
		return nil, errors.New("database path is required")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil && filepath.Dir(path) != "." {
		return nil, fmt.Errorf("create database directory %s: %w", filepath.Dir(path), err)
	}
	db, err := sql.Open("sqlite", sqliteDSN(path))
	if err != nil {
		return nil, fmt.Errorf("open sqlite database %s: %w", path, err)
	}
	// SQLite allows one writer; a single shared connection removes SQLITE_BUSY
	// between this process's own goroutines entirely, and read volume here is trivial.
	db.SetMaxOpenConns(1)
	store := &Store{db: db}
	if err := store.migrate(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("migrate sqlite database %s: %w", path, err)
	}
	return store, nil
}

func sqliteDSN(path string) string {
	if path == ":memory:" {
		return "file::memory:?cache=shared&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)"
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		absPath = path
	}
	uriPath := filepath.ToSlash(absPath)
	if volume := filepath.VolumeName(absPath); volume != "" && !strings.HasPrefix(uriPath, "/") {
		uriPath = "/" + uriPath
	}
	uri := url.URL{Scheme: "file", Path: uriPath}
	query := url.Values{}
	query.Add("_pragma", "foreign_keys(1)")
	query.Add("_pragma", "busy_timeout(5000)")
	uri.RawQuery = query.Encode()
	return uri.String()
}

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) migrate(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS issue_threads (
  issue_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  completion_reason TEXT,
  last_payload_json TEXT,
  next_revisit_at TEXT,
  revisit_reason TEXT
);

CREATE TABLE IF NOT EXISTS issue_thread_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id TEXT NOT NULL,
  event_key TEXT,
  event_type TEXT NOT NULL,
  actor TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES issue_threads(issue_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_issue_thread_events_issue_event_key
ON issue_thread_events(issue_id, event_key)
WHERE event_key IS NOT NULL AND event_key != '';

CREATE TABLE IF NOT EXISTS issue_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id TEXT NOT NULL,
  source_event_type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  posted INTEGER NOT NULL DEFAULT 0,
  attribution TEXT,
  error TEXT,
  completion_reason TEXT,
  FOREIGN KEY (issue_id) REFERENCES issue_threads(issue_id)
);

	`)
	if err != nil {
		return fmt.Errorf("run base schema migration: %w", err)
	}
	if err := s.ensureColumn(ctx, "issue_threads", "next_revisit_at", "TEXT"); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "issue_threads", "revisit_reason", "TEXT"); err != nil {
		return err
	}
	return nil
}

func (s *Store) ensureColumn(ctx context.Context, table, column, columnType string) error {
	rows, err := s.db.QueryContext(ctx, `SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		return fmt.Errorf("inspect %s schema: %w", table, err)
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return fmt.Errorf("inspect %s schema: %w", table, err)
		}
		if name == column {
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("inspect %s schema: %w", table, err)
	}
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE `+table+` ADD COLUMN `+column+` `+columnType); err != nil {
		return fmt.Errorf("add column %s.%s: %w", table, column, err)
	}
	return nil
}
