package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
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
`)
	return err
}

func (s *Store) LoadIssueThread(ctx context.Context, issueID string) (IssueThread, bool, error) {
	var thread IssueThread
	var completedAt, reason sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT issue_id,status,created_at,updated_at,completed_at,completion_reason,last_payload_json FROM issue_threads WHERE issue_id = ?`, issueID).Scan(
		&thread.IssueID, &thread.Status, scanTime(&thread.CreatedAt), scanTime(&thread.UpdatedAt), &completedAt, &reason, &thread.LastPayloadJSON,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return IssueThread{}, false, nil
	}
	if err != nil {
		return IssueThread{}, false, err
	}
	thread.CompletedAt = parseNullTime(completedAt)
	thread.CompletionReason = reason.String

	events, err := s.LoadIssueEvents(ctx, issueID)
	if err != nil {
		return IssueThread{}, false, err
	}
	runs, err := s.LoadIssueRuns(ctx, issueID)
	if err != nil {
		return IssueThread{}, false, err
	}
	thread.Events = events
	thread.Runs = runs
	return thread, true, nil
}

func (s *Store) UpsertIssueThread(ctx context.Context, thread IssueThread) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO issue_threads(issue_id,status,created_at,updated_at,completed_at,completion_reason,last_payload_json)
VALUES(?,?,?,?,?,?,?)
ON CONFLICT(issue_id) DO UPDATE SET
  status=excluded.status,
  updated_at=excluded.updated_at,
  completed_at=excluded.completed_at,
  completion_reason=excluded.completion_reason,
  last_payload_json=excluded.last_payload_json
`, thread.IssueID, thread.Status, formatTime(thread.CreatedAt), formatTime(thread.UpdatedAt), formatTimePtr(thread.CompletedAt), thread.CompletionReason, thread.LastPayloadJSON)
	return err
}

func (s *Store) InsertIssueEvent(ctx context.Context, event IssueEvent) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO issue_thread_events(issue_id,event_type,actor,message,payload_json,created_at) VALUES(?,?,?,?,?,?)`,
		event.IssueID, event.EventType, event.Actor, event.Message, event.PayloadJSON, formatTime(event.CreatedAt))
	return err
}

func (s *Store) InsertIssueRun(ctx context.Context, run IssueRun) error {
	posted := 0
	if run.Posted {
		posted = 1
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO issue_runs(issue_id,source_event_type,started_at,completed_at,final_comment,posted,attribution,error,completion_reason) VALUES(?,?,?,?,?,?,?,?,?)`,
		run.IssueID, run.SourceEventType, formatTime(run.StartedAt), formatTimePtr(run.CompletedAt), run.FinalComment, posted, run.Attribution, run.Error, run.CompletionReason)
	return err
}

func (s *Store) InsertAutomationRun(ctx context.Context, run AutomationRun) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO automation_runs(automation_name,started_at,completed_at,result,error) VALUES(?,?,?,?,?)`,
		run.AutomationName, formatTime(run.StartedAt), formatTimePtr(run.CompletedAt), run.Result, run.Error)
	return err
}

func (s *Store) LoadIssueEvents(ctx context.Context, issueID string) ([]IssueEvent, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,issue_id,event_type,actor,message,payload_json,created_at FROM issue_thread_events WHERE issue_id = ? ORDER BY id`, issueID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []IssueEvent
	for rows.Next() {
		var event IssueEvent
		if err := rows.Scan(&event.ID, &event.IssueID, &event.EventType, &event.Actor, &event.Message, &event.PayloadJSON, scanTime(&event.CreatedAt)); err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	return events, rows.Err()
}

func (s *Store) LoadIssueRuns(ctx context.Context, issueID string) ([]IssueRun, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,issue_id,source_event_type,started_at,completed_at,final_comment,posted,attribution,error,completion_reason FROM issue_runs WHERE issue_id = ? ORDER BY id`, issueID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var runs []IssueRun
	for rows.Next() {
		var run IssueRun
		var completedAt sql.NullString
		var posted int
		if err := rows.Scan(&run.ID, &run.IssueID, &run.SourceEventType, scanTime(&run.StartedAt), &completedAt, &run.FinalComment, &posted, &run.Attribution, &run.Error, &run.CompletionReason); err != nil {
			return nil, err
		}
		run.CompletedAt = parseNullTime(completedAt)
		run.Posted = posted == 1
		runs = append(runs, run)
	}
	return runs, rows.Err()
}

func AppendJSONL(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(file, string(data))
	return err
}

func formatTime(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}

func formatTimePtr(value *time.Time) any {
	if value == nil {
		return nil
	}
	return formatTime(*value)
}

func scanTime(target *time.Time) any {
	return sqlScannerFunc(func(src any) error {
		value, ok := src.(string)
		if !ok {
			if bytes, ok := src.([]byte); ok {
				value = string(bytes)
			} else {
				return fmt.Errorf("unexpected time value %T", src)
			}
		}
		parsed, err := time.Parse(time.RFC3339Nano, value)
		if err != nil {
			return err
		}
		*target = parsed
		return nil
	})
}

func parseNullTime(value sql.NullString) *time.Time {
	if !value.Valid || value.String == "" {
		return nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, value.String)
	if err != nil {
		return nil
	}
	return &parsed
}

type sqlScannerFunc func(any) error

func (f sqlScannerFunc) Scan(src any) error {
	return f(src)
}
