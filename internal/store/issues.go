package store

import (
	"context"
	"database/sql"
	"errors"
)

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
