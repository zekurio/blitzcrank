package harness

import (
	"context"
	"encoding/json"
	"log"
	"path/filepath"
	"strings"
	"time"

	"blitzcrank/internal/runtimectx"
	"blitzcrank/internal/store"
)

func (m *Manager) loadThread(ctx context.Context, issueID string) (*IssueThread, bool) {
	if m.store == nil {
		return nil, false
	}
	loaded, ok, err := m.store.LoadIssueThread(ctx, issueID)
	if err != nil || !ok {
		if err != nil {
			log.Printf("load issue thread %s: %v", issueID, err)
		}
		return nil, false
	}
	thread := &IssueThread{
		IssueID:          loaded.IssueID,
		Status:           loaded.Status,
		Summary:          loaded.Summary,
		CreatedAt:        loaded.CreatedAt,
		UpdatedAt:        loaded.UpdatedAt,
		CompletedAt:      loaded.CompletedAt,
		CompletionReason: loaded.CompletionReason,
		LastPayload:      json.RawMessage(loaded.LastPayloadJSON),
	}
	for _, event := range loaded.Events {
		thread.Events = append(thread.Events, ThreadEvent{
			Type:    event.EventType,
			Key:     event.EventKey,
			Actor:   event.Actor,
			Message: event.Message,
			Payload: json.RawMessage(event.PayloadJSON),
			At:      event.CreatedAt,
		})
	}
	for _, run := range loaded.Runs {
		completedAt := time.Time{}
		if run.CompletedAt != nil {
			completedAt = *run.CompletedAt
		}
		thread.Runs = append(thread.Runs, RunRecord{
			StartedAt:        run.StartedAt,
			CompletedAt:      completedAt,
			FinalComment:     run.FinalComment,
			Posted:           run.Posted,
			Attribution:      run.Attribution,
			Error:            run.Error,
			CompletionReason: run.CompletionReason,
		})
	}
	m.hydrateIssueThreadContent(thread)
	return thread, true
}

func (m *Manager) upsertThread(ctx context.Context, thread *IssueThread) {
	if m.store == nil {
		return
	}
	if err := m.store.UpsertIssueThread(ctx, store.IssueThread{
		IssueID:          thread.IssueID,
		Status:           thread.Status,
		Summary:          thread.Summary,
		CreatedAt:        thread.CreatedAt,
		UpdatedAt:        thread.UpdatedAt,
		CompletedAt:      thread.CompletedAt,
		CompletionReason: thread.CompletionReason,
		LastPayloadJSON:  string(thread.LastPayload),
	}); err != nil {
		log.Printf("upsert issue thread %s: %v", thread.IssueID, err)
	}
}

func (m *Manager) insertEvent(ctx context.Context, issueID string, event ThreadEvent) {
	if m.store == nil {
		return
	}
	if err := m.store.InsertIssueEvent(ctx, store.IssueEvent{
		IssueID:     issueID,
		EventKey:    event.Key,
		EventType:   event.Type,
		Actor:       event.Actor,
		Message:     event.Message,
		PayloadJSON: string(event.Payload),
		CreatedAt:   event.At,
	}); err != nil {
		log.Printf("insert issue event %s: %v", issueID, err)
	}
}

func (m *Manager) insertRun(ctx context.Context, issueID string, run RunRecord, sourceEventType string) {
	if m.store == nil {
		return
	}
	completedAt := run.CompletedAt
	if err := m.store.InsertIssueRun(ctx, store.IssueRun{
		IssueID:          issueID,
		SourceEventType:  sourceEventType,
		StartedAt:        run.StartedAt,
		CompletedAt:      &completedAt,
		FinalComment:     run.FinalComment,
		Posted:           run.Posted,
		Attribution:      run.Attribution,
		Error:            run.Error,
		CompletionReason: run.CompletionReason,
	}); err != nil {
		log.Printf("insert issue run %s: %v", issueID, err)
	}
}

func (m *Manager) appendTrace(relPath string, value any) {
	if err := store.AppendJSONL(filepath.Join(m.cfg.ThreadsDirectory, relPath), value); err != nil {
		log.Printf("append trace %s: %v", relPath, err)
	}
}

func (m *Manager) recordIssuePromptCompactions(issueID string, entries []runtimectx.CompactionEntry) {
	if strings.TrimSpace(m.cfg.ThreadsDirectory) == "" || len(entries) == 0 {
		return
	}
	ledgerPath := filepath.Join(m.cfg.ThreadsDirectory, "issues", "issue-"+issueID+".compactions.jsonl")
	if err := runtimectx.AppendCompactionEntries(ledgerPath, entries); err != nil {
		log.Printf("append issue compaction ledger %s: %v", issueID, err)
		return
	}
	for _, entry := range entries {
		m.appendTrace("issues/issue-"+issueID+".jsonl", map[string]any{
			"type":                 "context_compaction",
			"issue":                issueID,
			"entry_id":             entry.ID,
			"summary":              entry.Summary,
			"first_kept_entry_id":  entry.FirstKeptEntryID,
			"tokens_before":        entry.TokensBefore,
			"compaction_timestamp": entry.Timestamp,
			"details":              entry.Details,
		})
	}
}

func (m *Manager) hydrateIssueThreadContent(thread *IssueThread) {
	if thread == nil {
		return
	}
	records, err := store.ReadJSONL(filepath.Join(m.cfg.ThreadsDirectory, "issues", "issue-"+thread.IssueID+".jsonl"))
	if err != nil {
		log.Printf("read issue trace %s: %v", thread.IssueID, err)
		return
	}
	eventByKey := make(map[string]string)
	var eventMessages []string
	var runComments []string
	for _, record := range records {
		switch stringValue(record, "type") {
		case "webhook_event":
			message := stringValue(record, "message")
			if key := stringValue(record, "key"); key != "" && message != "" {
				eventByKey[key] = message
			}
			if message != "" {
				eventMessages = append(eventMessages, message)
			}
		case "agent_run":
			if comment := stringValue(record, "final_comment"); comment != "" {
				runComments = append(runComments, comment)
			}
		}
	}
	nextEvent := 0
	for i := range thread.Events {
		if thread.Events[i].Message != "" {
			continue
		}
		if message := eventByKey[thread.Events[i].Key]; message != "" {
			thread.Events[i].Message = message
			continue
		}
		if nextEvent < len(eventMessages) {
			thread.Events[i].Message = eventMessages[nextEvent]
			nextEvent++
		}
	}
	for i := range thread.Runs {
		if thread.Runs[i].FinalComment != "" || i >= len(runComments) {
			continue
		}
		thread.Runs[i].FinalComment = runComments[i]
	}
}
