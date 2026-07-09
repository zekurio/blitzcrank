package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

const (
	DiscordConversationActive   = "active"
	DiscordConversationArchived = "archived"
	DiscordMessageClaimed       = "claimed"
	DiscordMessageRunning       = "running"
	DiscordRunRunning           = "running"
	// DiscordStatusInterrupted marks work that a restart tore down. Interrupted
	// work is terminal: it is never replayed, because the turn may already have
	// applied mutations that the new process cannot observe.
	DiscordStatusInterrupted = "interrupted"
)

// DiscordConversation stores only routing and ownership metadata. Private
// message content remains in Discord and the source-isolated Pi session.
type DiscordConversation struct {
	ThreadID         string
	ParentChannelID  string
	OwnerID          string
	TriggerMessageID string
	Route            string
	Category         string
	Status           string
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// DiscordMessage is the durable deduplication record for one Discord event.
// It intentionally has no field capable of storing the message body.
type DiscordMessage struct {
	MessageID   string
	ChannelID   string
	AuthorID    string
	Status      string
	ReceivedAt  time.Time
	CompletedAt *time.Time
	Error       string
}

// DiscordRun records enough metadata to detect work interrupted by a restart
// without duplicating the private request or response content.
type DiscordRun struct {
	ID        string
	MessageID string
	// BatchMessageIDs names the debounced messages the run consumed alongside
	// MessageID. It is not persisted as a column; StartDiscordRun uses it to
	// move every consumed message out of the retryable claimed state.
	BatchMessageIDs []string
	ThreadID        string
	Source          string
	ActorID         string
	Route           string
	Category        string
	Status          string
	StartedAt       time.Time
	CompletedAt     *time.Time
	Error           string
}

// consumedMessageIDs lists every message the run takes ownership of, anchor
// first, with blanks and duplicates removed.
func (r DiscordRun) consumedMessageIDs() []string {
	ids := make([]string, 0, len(r.BatchMessageIDs)+1)
	seen := make(map[string]struct{}, len(r.BatchMessageIDs)+1)
	for _, id := range append([]string{r.MessageID}, r.BatchMessageIDs...) {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	return ids
}

func (s *Store) UpsertDiscordConversation(ctx context.Context, conversation DiscordConversation) error {
	status := strings.TrimSpace(conversation.Status)
	if status == "" {
		status = DiscordConversationActive
	}
	_, err := s.db.ExecContext(ctx, `
INSERT INTO discord_conversations(thread_id,parent_channel_id,owner_id,trigger_message_id,route,category,status,created_at,updated_at)
VALUES(?,?,?,?,?,?,?,?,?)
ON CONFLICT(thread_id) DO UPDATE SET
  parent_channel_id=excluded.parent_channel_id,
  owner_id=excluded.owner_id,
  trigger_message_id=excluded.trigger_message_id,
  route=excluded.route,
  category=excluded.category,
  status=excluded.status,
  updated_at=excluded.updated_at
`, conversation.ThreadID, conversation.ParentChannelID, conversation.OwnerID, conversation.TriggerMessageID, conversation.Route, conversation.Category, status, formatTime(conversation.CreatedAt), formatTime(conversation.UpdatedAt))
	return err
}

func (s *Store) LoadDiscordConversation(ctx context.Context, threadID string) (DiscordConversation, bool, error) {
	var conversation DiscordConversation
	err := s.db.QueryRowContext(ctx, `
SELECT thread_id,parent_channel_id,owner_id,trigger_message_id,route,category,status,created_at,updated_at
FROM discord_conversations
WHERE thread_id = ?
`, threadID).Scan(&conversation.ThreadID, &conversation.ParentChannelID, &conversation.OwnerID, &conversation.TriggerMessageID, &conversation.Route, &conversation.Category, &conversation.Status, scanTime(&conversation.CreatedAt), scanTime(&conversation.UpdatedAt))
	if errors.Is(err, sql.ErrNoRows) {
		return DiscordConversation{}, false, nil
	}
	if err != nil {
		return DiscordConversation{}, false, err
	}
	return conversation, true, nil
}

func (s *Store) ListRecoverableDiscordConversations(ctx context.Context) ([]DiscordConversation, error) {
	return s.listDiscordConversations(ctx, true)
}

// ListDiscordConversations returns both active and archived conversations.
// Archived ownership metadata remains recoverable until its private Pi session
// reaches the configured retention deadline.
func (s *Store) ListDiscordConversations(ctx context.Context) ([]DiscordConversation, error) {
	return s.listDiscordConversations(ctx, false)
}

func (s *Store) listDiscordConversations(ctx context.Context, activeOnly bool) ([]DiscordConversation, error) {
	query := `
SELECT thread_id,parent_channel_id,owner_id,trigger_message_id,route,category,status,created_at,updated_at
FROM discord_conversations`
	var args []any
	if activeOnly {
		query += ` WHERE status = ?`
		args = append(args, DiscordConversationActive)
	}
	rows, err := s.db.QueryContext(ctx, `
`+query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var conversations []DiscordConversation
	for rows.Next() {
		var conversation DiscordConversation
		if err := rows.Scan(&conversation.ThreadID, &conversation.ParentChannelID, &conversation.OwnerID, &conversation.TriggerMessageID, &conversation.Route, &conversation.Category, &conversation.Status, scanTime(&conversation.CreatedAt), scanTime(&conversation.UpdatedAt)); err != nil {
			return nil, err
		}
		conversations = append(conversations, conversation)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(conversations, func(i, j int) bool {
		if conversations[i].UpdatedAt.Equal(conversations[j].UpdatedAt) {
			return conversations[i].ThreadID < conversations[j].ThreadID
		}
		return conversations[i].UpdatedAt.Before(conversations[j].UpdatedAt)
	})
	return conversations, nil
}

func (s *Store) DeleteDiscordConversation(ctx context.Context, threadID string) error {
	result, err := s.db.ExecContext(ctx, `DELETE FROM discord_conversations WHERE thread_id = ?`, threadID)
	if err != nil {
		return err
	}
	return requireUpdatedRow(result, "discord conversation", threadID)
}

// ClaimDiscordMessage atomically records a Discord message. It returns false
// when another handler or an earlier process invocation already claimed it.
func (s *Store) ClaimDiscordMessage(ctx context.Context, message DiscordMessage) (bool, error) {
	status := strings.TrimSpace(message.Status)
	if status == "" {
		status = DiscordMessageClaimed
	}
	result, err := s.db.ExecContext(ctx, `
INSERT INTO discord_messages(message_id,channel_id,author_id,status,received_at)
VALUES(?,?,?,?,?)
ON CONFLICT(message_id) DO NOTHING
`, message.MessageID, message.ChannelID, message.AuthorID, status, formatTime(message.ReceivedAt))
	if err != nil {
		return false, err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	return rows == 1, nil
}

func (s *Store) LoadDiscordMessage(ctx context.Context, messageID string) (DiscordMessage, bool, error) {
	var message DiscordMessage
	var completedAt, storedErr sql.NullString
	err := s.db.QueryRowContext(ctx, `
SELECT message_id,channel_id,author_id,status,received_at,completed_at,error
FROM discord_messages
WHERE message_id = ?
`, messageID).Scan(&message.MessageID, &message.ChannelID, &message.AuthorID, &message.Status, scanTime(&message.ReceivedAt), &completedAt, &storedErr)
	if errors.Is(err, sql.ErrNoRows) {
		return DiscordMessage{}, false, nil
	}
	if err != nil {
		return DiscordMessage{}, false, err
	}
	message.CompletedAt, err = parseNullTime(completedAt)
	if err != nil {
		return DiscordMessage{}, false, err
	}
	message.Error = storedErr.String
	return message, true, nil
}

func (s *Store) ListRecoverableDiscordMessages(ctx context.Context) ([]DiscordMessage, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT message_id,channel_id,author_id,status,received_at,completed_at,error
FROM discord_messages
WHERE completed_at IS NULL AND status = ?
ORDER BY received_at, message_id
`, DiscordMessageClaimed)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var messages []DiscordMessage
	for rows.Next() {
		var message DiscordMessage
		var completedAt, storedErr sql.NullString
		if err := rows.Scan(&message.MessageID, &message.ChannelID, &message.AuthorID, &message.Status, scanTime(&message.ReceivedAt), &completedAt, &storedErr); err != nil {
			return nil, err
		}
		message.CompletedAt, err = parseNullTime(completedAt)
		if err != nil {
			return nil, err
		}
		message.Error = storedErr.String
		messages = append(messages, message)
	}
	return messages, rows.Err()
}

func (s *Store) CompleteDiscordMessage(ctx context.Context, messageID, status, sanitizedError string, completedAt time.Time) error {
	result, err := s.db.ExecContext(ctx, `
UPDATE discord_messages
SET status = ?, completed_at = ?, error = ?
WHERE message_id = ?
`, status, formatTime(completedAt), storedSanitizedError(sanitizedError), messageID)
	if err != nil {
		return err
	}
	return requireUpdatedRow(result, "discord message", messageID)
}

func (s *Store) StartDiscordRun(ctx context.Context, run DiscordRun) error {
	status := strings.TrimSpace(run.Status)
	if status == "" {
		status = DiscordRunRunning
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `
INSERT INTO discord_runs(run_id,message_id,thread_id,source,actor_id,route,category,status,started_at)
VALUES(?,?,?,?,?,?,?,?,?)
`, run.ID, run.MessageID, run.ThreadID, run.Source, run.ActorID, run.Route, run.Category, status, formatTime(run.StartedAt))
	if err != nil {
		return err
	}
	// Every consumed message leaves the claimed state in the same transaction as
	// the run insert. A message that is still claimed after a crash therefore
	// provably never reached an agent and stays safe to retry.
	for _, messageID := range run.consumedMessageIDs() {
		result, err := tx.ExecContext(ctx, `UPDATE discord_messages SET status = ? WHERE message_id = ?`, DiscordMessageRunning, messageID)
		if err != nil {
			return err
		}
		if err := requireUpdatedRow(result, "discord message", messageID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// MarkInterruptedDiscordMessages closes out messages that were mid-run when the
// process died. A freshly started process owns no running turn, so every
// running message is an orphan of the previous invocation. Claimed messages are
// deliberately left alone: they never reached an agent and remain retryable.
func (s *Store) MarkInterruptedDiscordMessages(ctx context.Context, sanitizedError string, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE discord_messages
SET status = ?, completed_at = ?, error = ?
WHERE completed_at IS NULL AND status = ?
`, DiscordStatusInterrupted, formatTime(at), storedSanitizedError(sanitizedError), DiscordMessageRunning)
	return err
}

func (s *Store) CompleteDiscordRun(ctx context.Context, runID, status, sanitizedError string, completedAt time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var messageID string
	if err := tx.QueryRowContext(ctx, `SELECT message_id FROM discord_runs WHERE run_id = ?`, runID).Scan(&messageID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("discord run %q does not exist", runID)
		}
		return err
	}
	storedErr := storedSanitizedError(sanitizedError)
	if _, err := tx.ExecContext(ctx, `
UPDATE discord_runs SET status = ?, completed_at = ?, error = ? WHERE run_id = ?
`, status, formatTime(completedAt), storedErr, runID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE discord_messages SET status = ?, completed_at = ?, error = ? WHERE message_id = ?
`, status, formatTime(completedAt), storedErr, messageID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) ListRecoverableDiscordRuns(ctx context.Context) ([]DiscordRun, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT run_id,message_id,thread_id,source,actor_id,route,category,status,started_at,completed_at,error
FROM discord_runs
WHERE completed_at IS NULL
`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var runs []DiscordRun
	for rows.Next() {
		var run DiscordRun
		var completedAt, storedErr sql.NullString
		if err := rows.Scan(&run.ID, &run.MessageID, &run.ThreadID, &run.Source, &run.ActorID, &run.Route, &run.Category, &run.Status, scanTime(&run.StartedAt), &completedAt, &storedErr); err != nil {
			return nil, err
		}
		run.CompletedAt, err = parseNullTime(completedAt)
		if err != nil {
			return nil, err
		}
		run.Error = storedErr.String
		runs = append(runs, run)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(runs, func(i, j int) bool {
		if runs[i].StartedAt.Equal(runs[j].StartedAt) {
			return runs[i].ID < runs[j].ID
		}
		return runs[i].StartedAt.Before(runs[j].StartedAt)
	})
	return runs, nil
}

// PruneDiscordState removes expired completed message and run metadata.
// Conversation retention is coordinated with private Pi session deletion by
// the Discord lifecycle manager and must not be pruned independently here.
func (s *Store) PruneDiscordState(ctx context.Context, before time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	cutoff := formatTime(before)
	if _, err := tx.ExecContext(ctx, `DELETE FROM discord_runs WHERE completed_at IS NOT NULL AND julianday(completed_at) < julianday(?)`, cutoff); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
DELETE FROM discord_messages
WHERE completed_at IS NOT NULL
  AND julianday(completed_at) < julianday(?)
  AND NOT EXISTS (SELECT 1 FROM discord_runs WHERE discord_runs.message_id = discord_messages.message_id)
`, cutoff); err != nil {
		return err
	}
	return tx.Commit()
}

func requireUpdatedRow(result sql.Result, kind, id string) error {
	rows, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if rows == 0 {
		return fmt.Errorf("%s %q does not exist", kind, id)
	}
	return nil
}

func storedSanitizedError(value string) string {
	value = strings.Join(strings.Fields(value), " ")
	const maxRunes = 512
	runes := []rune(value)
	if len(runes) <= maxRunes {
		return value
	}
	return string(runes[:maxRunes])
}
