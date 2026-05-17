package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
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

type AgentThread struct {
	ThreadID         string
	Source           string
	ExternalID       string
	ParentExternalID string
	RootExternalID   string
	Status           string
	Title            string
	Summary          string
	CreatedAt        time.Time
	UpdatedAt        time.Time
	CompletedAt      *time.Time
	CompletionReason string
	LastPayloadJSON  string
	Events           []AgentThreadEvent
	Runs             []AgentRun
}

type AgentThreadEvent struct {
	ID                int64
	ThreadID          string
	EventType         string
	Actor             string
	ActorID           string
	Message           string
	ExternalMessageID string
	PayloadJSON       string
	CreatedAt         time.Time
}

type AgentRun struct {
	ID               int64
	ThreadID         string
	SourceEventType  string
	StartedAt        time.Time
	CompletedAt      *time.Time
	FinalResponse    string
	Posted           bool
	Attribution      string
	Error            string
	CompletionReason string
	Summary          string
}

func Open(ctx context.Context, path string) (*Store, error) {
	if path == "" {
		return nil, errors.New("database path is required")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil && filepath.Dir(path) != "." {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	store := &Store{db: db}
	if err := store.migrate(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
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
  last_payload_json TEXT
);

CREATE TABLE IF NOT EXISTS issue_thread_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id TEXT NOT NULL,
  event_key TEXT,
  event_type TEXT NOT NULL,
  actor TEXT,
  message TEXT,
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
  final_comment TEXT,
  posted INTEGER NOT NULL DEFAULT 0,
  attribution TEXT,
  error TEXT,
  completion_reason TEXT,
  FOREIGN KEY (issue_id) REFERENCES issue_threads(issue_id)
);

CREATE TABLE IF NOT EXISTS agent_threads (
  thread_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  parent_external_id TEXT,
  root_external_id TEXT,
  status TEXT NOT NULL,
  title TEXT,
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  completion_reason TEXT,
  last_payload_json TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_threads_source_external
ON agent_threads(source, external_id);

CREATE TABLE IF NOT EXISTS agent_thread_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT,
  actor_id TEXT,
  message TEXT,
  external_message_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES agent_threads(thread_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_thread_events_thread_id
ON agent_thread_events(thread_id, id);

CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  source_event_type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  final_response TEXT,
  posted INTEGER NOT NULL DEFAULT 0,
  attribution TEXT,
  error TEXT,
  completion_reason TEXT,
  FOREIGN KEY (thread_id) REFERENCES agent_threads(thread_id)
);
`)
	if err != nil {
		return err
	}
	for _, column := range []struct {
		table string
		name  string
		ddl   string
	}{
		{table: "issue_threads", name: "summary", ddl: "ALTER TABLE issue_threads ADD COLUMN summary TEXT"},
		{table: "issue_thread_events", name: "event_key", ddl: "ALTER TABLE issue_thread_events ADD COLUMN event_key TEXT"},
	} {
		if err := s.ensureColumn(ctx, column.table, column.name, column.ddl); err != nil {
			return err
		}
	}
	_, err = s.db.ExecContext(ctx, `
CREATE UNIQUE INDEX IF NOT EXISTS idx_issue_thread_events_issue_event_key
ON issue_thread_events(issue_id, event_key)
WHERE event_key IS NOT NULL AND event_key != '';

`)
	return err
}

func (s *Store) ensureColumn(ctx context.Context, table, name, ddl string) error {
	rows, err := s.db.QueryContext(ctx, "PRAGMA table_info("+sanitizeIdentifier(table)+")")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var columnName, columnType string
		var notNull int
		var defaultValue any
		var pk int
		if err := rows.Scan(&cid, &columnName, &columnType, &notNull, &defaultValue, &pk); err != nil {
			return err
		}
		if strings.EqualFold(columnName, name) {
			return rows.Err()
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, ddl)
	return err
}

func sanitizeIdentifier(value string) string {
	value = strings.TrimSpace(value)
	for _, r := range value {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '_' {
			panic(fmt.Sprintf("unsafe SQL identifier %q", value))
		}
	}
	return value
}
