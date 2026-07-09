package harness

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"
)

const (
	revisitSweepInterval = 5 * time.Minute
	// revisitRetryDelay reschedules a revisit whose agent run failed so a
	// persistent failure cannot retry on every sweep.
	revisitRetryDelay = 30 * time.Minute
	minRevisitDelay   = 10 * time.Minute
	maxRevisitDelay   = 48 * time.Hour
)

// StartRevisitLoop periodically checks for issue threads whose agent asked to
// be revisited (REVISIT_IN/REVISIT_REASON directives) and re-runs them once
// the scheduled time has passed. Disabled unless SeerrRevisitsEnabled is set.
func (m *Manager) StartRevisitLoop(ctx context.Context) {
	if !m.cfg.SeerrRevisitsEnabled || m.store == nil {
		return
	}
	log.Printf("seerr issue revisits enabled: max_consecutive=%d", m.cfg.SeerrRevisitMax)
	go func() {
		ticker := time.NewTicker(revisitSweepInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				m.RevisitSweep(ctx)
			}
		}
	}()
}

// RevisitSweep runs one pass over active issue threads and revisits those the
// agent scheduled for follow-up.
func (m *Manager) RevisitSweep(ctx context.Context) {
	if m.store == nil {
		return
	}
	ids, err := m.store.ListActiveIssueThreadIDs(ctx)
	if err != nil {
		log.Printf("seerr revisit sweep failed: error=%v", err)
		return
	}
	for _, issueID := range ids {
		if ctx.Err() != nil {
			return
		}
		if err := m.revisitIssue(ctx, issueID); err != nil {
			log.Printf("seerr issue revisit failed: issue=%s error=%v", issueID, err)
		}
	}
}

func (m *Manager) revisitIssue(ctx context.Context, issueID string) error {
	lock := m.issueLock(issueID)
	lock.Lock()
	defer lock.Unlock()

	thread := m.lookupThread(ctx, issueID)
	if thread == nil {
		return nil
	}
	now := time.Now().UTC()
	if !m.revisitDue(thread, now) {
		return nil
	}

	payload := map[string]any{
		"event":          "revisit",
		"issue_id":       thread.IssueID,
		"revisit_reason": thread.RevisitReason,
		"scheduled_for":  thread.NextRevisitAt.Format(time.RFC3339),
	}
	data, _ := json.Marshal(payload)
	eventRecord := ThreadEvent{
		Type:    "revisit",
		Key:     fmt.Sprintf("revisit:%s:%d", thread.IssueID, now.Unix()),
		Actor:   "blitzcrank",
		Message: thread.RevisitReason,
		Payload: data,
		At:      now,
	}
	promptThread := cloneIssueThread(thread)
	promptThread.Events = append(promptThread.Events, eventRecord)

	log.Printf("seerr issue revisit started: issue=%s reason=%q trailing_revisits=%d", thread.IssueID, thread.RevisitReason, trailingRevisitEvents(thread.Events))
	record, err := m.run(ctx, promptThread, payload, "revisit", false)
	if err != nil {
		m.recordRun(ctx, thread, record, "revisit")
		m.rescheduleRevisit(ctx, thread, revisitRetryDelay)
		return err
	}
	m.appendEventRecord(ctx, thread, eventRecord, payload)
	m.recordRun(ctx, thread, record, "revisit")
	m.applyRevisitDecision(ctx, thread, record)
	if record.Resolved {
		m.complete(ctx, thread, "issue resolved after revisit")
	}
	return nil
}

// applyRevisitDecision applies the agent's follow-up request from the latest
// run: a positive RevisitIn re-arms the schedule, anything else clears it. A
// run that resolved the issue never re-arms.
func (m *Manager) applyRevisitDecision(ctx context.Context, thread *IssueThread, record RunRecord) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if record.Resolved || record.RevisitIn <= 0 || thread.Status != "active" {
		thread.NextRevisitAt = nil
		thread.RevisitReason = ""
		m.upsertThread(ctx, thread)
		return
	}
	at := time.Now().UTC().Add(clampRevisitDelay(record.RevisitIn))
	reason := record.RevisitReason
	if reason == "" {
		reason = "follow-up requested by agent without a recorded reason"
	}
	thread.NextRevisitAt = &at
	thread.RevisitReason = reason
	m.upsertThread(ctx, thread)
	log.Printf("seerr issue revisit scheduled: issue=%s at=%s reason=%q", thread.IssueID, at.Format(time.RFC3339), reason)
}

// rescheduleRevisit pushes an existing schedule forward, keeping the reason.
func (m *Manager) rescheduleRevisit(ctx context.Context, thread *IssueThread, delay time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if thread.Status != "active" || thread.NextRevisitAt == nil {
		return
	}
	at := time.Now().UTC().Add(delay)
	thread.NextRevisitAt = &at
	m.upsertThread(ctx, thread)
}

func clampRevisitDelay(delay time.Duration) time.Duration {
	if delay < minRevisitDelay {
		return minRevisitDelay
	}
	if delay > maxRevisitDelay {
		return maxRevisitDelay
	}
	return delay
}

// lookupThread returns the cached or persisted thread without mutating its
// status or activity timestamps, unlike threadForIssue.
func (m *Manager) lookupThread(ctx context.Context, issueID string) *IssueThread {
	m.mu.Lock()
	defer m.mu.Unlock()
	if thread := m.threads[issueID]; thread != nil {
		return thread
	}
	loaded, ok := m.loadThread(ctx, issueID)
	if !ok {
		return nil
	}
	m.threads[issueID] = loaded
	return loaded
}

func (m *Manager) revisitDue(thread *IssueThread, now time.Time) bool {
	if thread == nil || thread.Status != "active" || thread.NextRevisitAt == nil {
		return false
	}
	if now.Before(*thread.NextRevisitAt) {
		return false
	}
	return trailingRevisitEvents(thread.Events) < m.cfg.SeerrRevisitMax
}

// trailingRevisitEvents counts revisit events since the last webhook-driven
// event; any new user activity resets the budget.
func trailingRevisitEvents(events []ThreadEvent) int {
	count := 0
	for i := len(events) - 1; i >= 0; i-- {
		if events[i].Type != "revisit" {
			break
		}
		count++
	}
	return count
}
