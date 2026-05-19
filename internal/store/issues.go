package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

func (s *Store) LoadIssueThread(ctx context.Context, issueID string) (IssueThread, bool, error) {
	var thread IssueThread
	var completedAt, reason sql.NullString
	var summary sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT issue_id,status,summary,created_at,updated_at,completed_at,completion_reason,last_payload_json FROM issue_threads WHERE issue_id = ?`, issueID).Scan(
		&thread.IssueID, &thread.Status, &summary, scanTime(&thread.CreatedAt), scanTime(&thread.UpdatedAt), &completedAt, &reason, &thread.LastPayloadJSON,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return IssueThread{}, false, nil
	}
	if err != nil {
		return IssueThread{}, false, err
	}
	thread.Summary = summary.String
	thread.CompletedAt, err = parseNullTime(completedAt)
	if err != nil {
		return IssueThread{}, false, err
	}
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
INSERT INTO issue_threads(issue_id,status,summary,created_at,updated_at,completed_at,completion_reason,last_payload_json)
VALUES(?,?,?,?,?,?,?,?)
ON CONFLICT(issue_id) DO UPDATE SET
  status=excluded.status,
  summary=excluded.summary,
  updated_at=excluded.updated_at,
  completed_at=excluded.completed_at,
  completion_reason=excluded.completion_reason,
  last_payload_json=excluded.last_payload_json
`, thread.IssueID, thread.Status, thread.Summary, formatTime(thread.CreatedAt), formatTime(thread.UpdatedAt), formatTimePtr(thread.CompletedAt), thread.CompletionReason, metadataJSON(thread.LastPayloadJSON))
	return err
}

func (s *Store) InsertIssueEvent(ctx context.Context, event IssueEvent) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO issue_thread_events(issue_id,event_key,event_type,actor,payload_json,created_at) VALUES(?,?,?,?,?,?)`,
		event.IssueID, event.EventKey, event.EventType, event.Actor, metadataJSON(event.PayloadJSON), formatTime(event.CreatedAt))
	return err
}

func (s *Store) InsertIssueRun(ctx context.Context, run IssueRun) error {
	posted := 0
	if run.Posted {
		posted = 1
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO issue_runs(issue_id,source_event_type,started_at,completed_at,posted,attribution,error,completion_reason) VALUES(?,?,?,?,?,?,?,?)`,
		run.IssueID, run.SourceEventType, formatTime(run.StartedAt), formatTimePtr(run.CompletedAt), posted, run.Attribution, run.Error, run.CompletionReason)
	return err
}

func (s *Store) UpdateIssueThreadSummary(ctx context.Context, issueID, summary string, updatedAt time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE issue_threads SET summary = ?, updated_at = ? WHERE issue_id = ?`, summary, formatTime(updatedAt), issueID)
	return err
}
