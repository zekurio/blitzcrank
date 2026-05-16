package store

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	db *sql.DB
}

type IssueThread struct {
	IssueID          string
	Status           string
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

type AutomationRun struct {
	AutomationName string
	StartedAt      time.Time
	CompletedAt    *time.Time
	Result         string
	Error          string
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  completion_reason TEXT,
  last_payload_json TEXT
);

CREATE TABLE IF NOT EXISTS issue_thread_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT,
  message TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES issue_threads(issue_id)
);

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

CREATE TABLE IF NOT EXISTS automation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  result TEXT,
  error TEXT
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
  summary TEXT,
  FOREIGN KEY (thread_id) REFERENCES agent_threads(thread_id)
);
`)
	return err
}
