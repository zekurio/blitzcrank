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
	var nextRevisitAt, revisitReason sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT issue_id,status,summary,created_at,updated_at,completed_at,completion_reason,next_revisit_at,revisit_reason,last_payload_json FROM issue_threads WHERE issue_id = ?`, issueID).Scan(
		&thread.IssueID, &thread.Status, &summary, scanTime(&thread.CreatedAt), scanTime(&thread.UpdatedAt), &completedAt, &reason, &nextRevisitAt, &revisitReason, &thread.LastPayloadJSON,
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
	thread.NextRevisitAt, err = parseNullTime(nextRevisitAt)
	if err != nil {
		return IssueThread{}, false, err
	}
	thread.RevisitReason = revisitReason.String
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
INSERT INTO issue_threads(issue_id,status,summary,created_at,updated_at,completed_at,completion_reason,next_revisit_at,revisit_reason,last_payload_json)
VALUES(?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(issue_id) DO UPDATE SET
  status=excluded.status,
  summary=excluded.summary,
  updated_at=excluded.updated_at,
  completed_at=excluded.completed_at,
  completion_reason=excluded.completion_reason,
  next_revisit_at=excluded.next_revisit_at,
  revisit_reason=excluded.revisit_reason,
  last_payload_json=excluded.last_payload_json
`, thread.IssueID, thread.Status, thread.Summary, formatTime(thread.CreatedAt), formatTime(thread.UpdatedAt), formatTimePtr(thread.CompletedAt), thread.CompletionReason, formatTimePtr(thread.NextRevisitAt), thread.RevisitReason, metadataJSON(thread.LastPayloadJSON))
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

func (s *Store) ListActiveIssueThreadIDs(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT issue_id FROM issue_threads WHERE status = 'active' ORDER BY issue_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *Store) LoadIssueEvents(ctx context.Context, issueID string) ([]IssueEvent, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,issue_id,event_key,event_type,actor,payload_json,created_at FROM issue_thread_events WHERE issue_id = ? ORDER BY id`, issueID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []IssueEvent
	for rows.Next() {
		var event IssueEvent
		var eventKey sql.NullString
		if err := rows.Scan(&event.ID, &event.IssueID, &eventKey, &event.EventType, &event.Actor, &event.PayloadJSON, scanTime(&event.CreatedAt)); err != nil {
			return nil, err
		}
		event.EventKey = eventKey.String
		events = append(events, event)
	}
	return events, rows.Err()
}

func (s *Store) LoadIssueRuns(ctx context.Context, issueID string) ([]IssueRun, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,issue_id,source_event_type,started_at,completed_at,posted,attribution,error,completion_reason FROM issue_runs WHERE issue_id = ? ORDER BY id`, issueID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var runs []IssueRun
	for rows.Next() {
		var run IssueRun
		var completedAt sql.NullString
		var posted int
		if err := rows.Scan(&run.ID, &run.IssueID, &run.SourceEventType, scanTime(&run.StartedAt), &completedAt, &posted, &run.Attribution, &run.Error, &run.CompletionReason); err != nil {
			return nil, err
		}
		run.CompletedAt, err = parseNullTime(completedAt)
		if err != nil {
			return nil, err
		}
		run.Posted = posted == 1
		runs = append(runs, run)
	}
	return runs, rows.Err()
}
