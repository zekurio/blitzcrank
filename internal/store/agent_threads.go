package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

func (s *Store) LoadAgentThread(ctx context.Context, threadID string) (AgentThread, bool, error) {
	var thread AgentThread
	var completedAt, reason, parentExternalID, rootExternalID, title, summary, lastPayload sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT thread_id,source,external_id,parent_external_id,root_external_id,status,title,summary,created_at,updated_at,completed_at,completion_reason,last_payload_json FROM agent_threads WHERE thread_id = ?`, threadID).Scan(
		&thread.ThreadID, &thread.Source, &thread.ExternalID, &parentExternalID, &rootExternalID, &thread.Status, &title, &summary, scanTime(&thread.CreatedAt), scanTime(&thread.UpdatedAt), &completedAt, &reason, &lastPayload,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return AgentThread{}, false, nil
	}
	if err != nil {
		return AgentThread{}, false, err
	}
	thread.ParentExternalID = parentExternalID.String
	thread.RootExternalID = rootExternalID.String
	thread.Title = title.String
	thread.Summary = summary.String
	thread.CompletedAt, err = parseNullTime(completedAt)
	if err != nil {
		return AgentThread{}, false, err
	}
	thread.CompletionReason = reason.String
	thread.LastPayloadJSON = lastPayload.String

	events, err := s.LoadAgentThreadEvents(ctx, threadID)
	if err != nil {
		return AgentThread{}, false, err
	}
	runs, err := s.LoadAgentRuns(ctx, threadID)
	if err != nil {
		return AgentThread{}, false, err
	}
	thread.Events = events
	thread.Runs = runs
	return thread, true, nil
}

func (s *Store) LoadAgentThreadByExternalID(ctx context.Context, source, externalID string) (AgentThread, bool, error) {
	var threadID string
	err := s.db.QueryRowContext(ctx, `SELECT thread_id FROM agent_threads WHERE source = ? AND external_id = ?`, source, externalID).Scan(&threadID)
	if errors.Is(err, sql.ErrNoRows) {
		return AgentThread{}, false, nil
	}
	if err != nil {
		return AgentThread{}, false, err
	}
	return s.LoadAgentThread(ctx, threadID)
}

func (s *Store) LoadAgentThreadByBotMessageID(ctx context.Context, source, messageID string) (AgentThread, bool, error) {
	messageID = strings.TrimSpace(messageID)
	if messageID == "" {
		return AgentThread{}, false, nil
	}
	thread, ok, err := s.LoadAgentThreadByExternalID(ctx, source, messageID)
	if err != nil || ok {
		return thread, ok, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT thread_id,last_payload_json FROM agent_threads WHERE source = ? AND last_payload_json <> ''`, source)
	if err != nil {
		return AgentThread{}, false, err
	}
	defer rows.Close()
	for rows.Next() {
		var threadID, payloadJSON string
		if err := rows.Scan(&threadID, &payloadJSON); err != nil {
			return AgentThread{}, false, err
		}
		if !agentThreadPayloadHasBotMessageID(payloadJSON, messageID) {
			continue
		}
		return s.LoadAgentThread(ctx, threadID)
	}
	if err := rows.Err(); err != nil {
		return AgentThread{}, false, err
	}
	return AgentThread{}, false, nil
}

func agentThreadPayloadHasBotMessageID(payloadJSON, messageID string) bool {
	var payload struct {
		BotMessageID       string   `json:"bot_message_id"`
		LatestBotMessageID string   `json:"latest_bot_message_id"`
		BotMessageIDs      []string `json:"bot_message_ids"`
	}
	if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
		return false
	}
	if strings.TrimSpace(payload.BotMessageID) == messageID || strings.TrimSpace(payload.LatestBotMessageID) == messageID {
		return true
	}
	for _, value := range payload.BotMessageIDs {
		if strings.TrimSpace(value) == messageID {
			return true
		}
	}
	return false
}

func (s *Store) LoadAgentThreadByRootExternalID(ctx context.Context, source, rootExternalID string) (AgentThread, bool, error) {
	var threadID string
	err := s.db.QueryRowContext(ctx, `SELECT thread_id FROM agent_threads WHERE source = ? AND root_external_id = ?`, source, rootExternalID).Scan(&threadID)
	if errors.Is(err, sql.ErrNoRows) {
		return AgentThread{}, false, nil
	}
	if err != nil {
		return AgentThread{}, false, err
	}
	return s.LoadAgentThread(ctx, threadID)
}

func (s *Store) UpsertAgentThread(ctx context.Context, thread AgentThread) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO agent_threads(thread_id,source,external_id,parent_external_id,root_external_id,status,title,summary,created_at,updated_at,completed_at,completion_reason,last_payload_json)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(thread_id) DO UPDATE SET
  source=excluded.source,
  external_id=excluded.external_id,
  parent_external_id=excluded.parent_external_id,
  root_external_id=excluded.root_external_id,
  status=excluded.status,
  title=excluded.title,
  summary=excluded.summary,
  updated_at=excluded.updated_at,
  completed_at=excluded.completed_at,
  completion_reason=excluded.completion_reason,
  last_payload_json=excluded.last_payload_json
`, thread.ThreadID, thread.Source, thread.ExternalID, thread.ParentExternalID, thread.RootExternalID, thread.Status, thread.Title, thread.Summary, formatTime(thread.CreatedAt), formatTime(thread.UpdatedAt), formatTimePtr(thread.CompletedAt), thread.CompletionReason, thread.LastPayloadJSON)
	return err
}

func (s *Store) UpdateAgentThreadSummary(ctx context.Context, threadID, summary string, updatedAt time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE agent_threads SET summary = ?, updated_at = ? WHERE thread_id = ?`, summary, formatTime(updatedAt), threadID)
	return err
}

func (s *Store) InsertAgentThreadEvent(ctx context.Context, event AgentThreadEvent) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO agent_thread_events(thread_id,event_type,actor,actor_id,message,external_message_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)`,
		event.ThreadID, event.EventType, event.Actor, event.ActorID, event.Message, event.ExternalMessageID, event.PayloadJSON, formatTime(event.CreatedAt))
	return err
}

func (s *Store) LoadLatestAgentThreadFeedbackEvent(ctx context.Context, threadID, messageID, actorID string) (AgentThreadEvent, bool, error) {
	var event AgentThreadEvent
	err := s.db.QueryRowContext(ctx, `
SELECT id,thread_id,event_type,actor,actor_id,message,external_message_id,payload_json,created_at
FROM agent_thread_events
WHERE thread_id = ? AND event_type = 'feedback' AND external_message_id = ? AND actor_id = ?
ORDER BY id DESC
LIMIT 1
`, threadID, messageID, actorID).Scan(
		&event.ID,
		&event.ThreadID,
		&event.EventType,
		&event.Actor,
		&event.ActorID,
		&event.Message,
		&event.ExternalMessageID,
		&event.PayloadJSON,
		scanTime(&event.CreatedAt),
	)
	if errors.Is(err, sql.ErrNoRows) {
		return AgentThreadEvent{}, false, nil
	}
	if err != nil {
		return AgentThreadEvent{}, false, err
	}
	return event, true, nil
}

func (s *Store) UpdateAgentThreadEvent(ctx context.Context, event AgentThreadEvent) error {
	_, err := s.db.ExecContext(ctx, `UPDATE agent_thread_events SET actor = ?, actor_id = ?, message = ?, external_message_id = ?, payload_json = ? WHERE id = ?`,
		event.Actor, event.ActorID, event.Message, event.ExternalMessageID, event.PayloadJSON, event.ID)
	return err
}

func (s *Store) InsertAgentRun(ctx context.Context, run AgentRun) error {
	posted := 0
	if run.Posted {
		posted = 1
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO agent_runs(thread_id,source_event_type,started_at,completed_at,final_response,posted,attribution,error,completion_reason,summary) VALUES(?,?,?,?,?,?,?,?,?,?)`,
		run.ThreadID, run.SourceEventType, formatTime(run.StartedAt), formatTimePtr(run.CompletedAt), run.FinalResponse, posted, run.Attribution, run.Error, run.CompletionReason, run.Summary)
	return err
}

func (s *Store) LoadIssueEvents(ctx context.Context, issueID string) ([]IssueEvent, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,issue_id,event_key,event_type,actor,message,payload_json,created_at FROM issue_thread_events WHERE issue_id = ? ORDER BY id`, issueID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []IssueEvent
	for rows.Next() {
		var event IssueEvent
		var eventKey sql.NullString
		if err := rows.Scan(&event.ID, &event.IssueID, &eventKey, &event.EventType, &event.Actor, &event.Message, &event.PayloadJSON, scanTime(&event.CreatedAt)); err != nil {
			return nil, err
		}
		event.EventKey = eventKey.String
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
		run.CompletedAt, err = parseNullTime(completedAt)
		if err != nil {
			return nil, err
		}
		run.Posted = posted == 1
		runs = append(runs, run)
	}
	return runs, rows.Err()
}

func (s *Store) LoadAgentThreadEvents(ctx context.Context, threadID string) ([]AgentThreadEvent, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,thread_id,event_type,actor,actor_id,message,external_message_id,payload_json,created_at FROM agent_thread_events WHERE thread_id = ? ORDER BY id`, threadID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []AgentThreadEvent
	for rows.Next() {
		var event AgentThreadEvent
		if err := rows.Scan(&event.ID, &event.ThreadID, &event.EventType, &event.Actor, &event.ActorID, &event.Message, &event.ExternalMessageID, &event.PayloadJSON, scanTime(&event.CreatedAt)); err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	return events, rows.Err()
}

func (s *Store) LoadAgentRuns(ctx context.Context, threadID string) ([]AgentRun, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,thread_id,source_event_type,started_at,completed_at,final_response,posted,attribution,error,completion_reason,summary FROM agent_runs WHERE thread_id = ? ORDER BY id`, threadID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var runs []AgentRun
	for rows.Next() {
		var run AgentRun
		var completedAt sql.NullString
		var posted int
		if err := rows.Scan(&run.ID, &run.ThreadID, &run.SourceEventType, scanTime(&run.StartedAt), &completedAt, &run.FinalResponse, &posted, &run.Attribution, &run.Error, &run.CompletionReason, &run.Summary); err != nil {
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
