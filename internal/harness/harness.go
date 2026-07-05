package harness

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"blitzcrank/internal/config"
	"blitzcrank/internal/store"
	"blitzcrank/internal/tools"
)

type Runner interface {
	Respond(context.Context, Request) (string, error)
}

type modelNamer interface {
	ModelName(Request) string
}

type runtimeInfoProvider interface {
	RuntimeInfo(Request) (string, string)
}

type Manager struct {
	cfg        config.Config
	runner     Runner
	tools      *tools.Registry
	store      *store.Store
	mu         sync.Mutex
	threads    map[string]*IssueThread
	issueLocks sync.Map
}

type IssueThread struct {
	IssueID          string          `json:"issue_id"`
	Status           string          `json:"status"`
	Summary          string          `json:"summary,omitempty"`
	CreatedAt        time.Time       `json:"created_at"`
	UpdatedAt        time.Time       `json:"updated_at"`
	CompletedAt      *time.Time      `json:"completed_at,omitempty"`
	CompletionReason string          `json:"completion_reason,omitempty"`
	NextRevisitAt    *time.Time      `json:"next_revisit_at,omitempty"`
	RevisitReason    string          `json:"revisit_reason,omitempty"`
	Events           []ThreadEvent   `json:"events"`
	Runs             []RunRecord     `json:"runs"`
	LastPayload      json.RawMessage `json:"last_payload,omitempty"`
}

type ThreadEvent struct {
	Type    string          `json:"type"`
	Key     string          `json:"key,omitempty"`
	Actor   string          `json:"actor,omitempty"`
	Message string          `json:"message,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
	At      time.Time       `json:"at"`
}

type RunRecord struct {
	StartedAt        time.Time `json:"started_at"`
	CompletedAt      time.Time `json:"completed_at"`
	FinalComment     string    `json:"final_comment,omitempty"`
	Posted           bool      `json:"posted"`
	Resolved         bool      `json:"resolved,omitempty"`
	Attribution      string    `json:"attribution"`
	Error            string    `json:"error,omitempty"`
	CompletionReason string    `json:"completion_reason,omitempty"`

	// RevisitIn and RevisitReason carry the agent's follow-up request to the
	// caller; they are applied to the thread, not persisted per run.
	RevisitIn     time.Duration `json:"-"`
	RevisitReason string        `json:"-"`
}

type Result struct {
	Ignored bool
	Reason  string
	IssueID string
	Event   string
}

func NewManager(cfg config.Config, runner Runner, registry *tools.Registry, state *store.Store) *Manager {
	return &Manager{
		cfg:     cfg,
		runner:  runner,
		tools:   registry,
		store:   state,
		threads: map[string]*IssueThread{},
	}
}

func (m *Manager) HandleWebhook(ctx context.Context, payload map[string]any) (Result, error) {
	event := classify(payload)
	issueID := issueID(payload)
	log.Printf("seerr webhook classified: issue=%s event=%s notification=%q actor=%q", issueID, event, stringValue(payload, "notification_type"), actor(payload))
	if issueID == "" {
		return Result{Ignored: true, Reason: "payload has no issue_id", Event: event}, nil
	}
	if event == "unknown" {
		return Result{Ignored: true, Reason: "payload is not an issue workflow event", IssueID: issueID, Event: event}, nil
	}

	if event == "comment" && m.botAuthored(payload) {
		return Result{Ignored: true, Reason: "bot-authored comment ignored", IssueID: issueID, Event: event}, nil
	}

	lock := m.issueLock(issueID)
	lock.Lock()
	defer lock.Unlock()

	key := webhookEventKey(payload)
	if m.hasEvent(ctx, issueID, key) {
		return Result{Ignored: true, Reason: "duplicate webhook event", IssueID: issueID, Event: event}, nil
	}

	switch event {
	case "resolved":
		thread := m.appendEvent(ctx, issueID, event, key, payload)
		m.complete(ctx, thread, "seerr issue resolved")
		return Result{IssueID: issueID, Event: event}, nil
	case "comment", "reported", "reopened":
		thread := m.threadForIssue(ctx, issueID, payload)
		eventRecord := m.newThreadEvent(event, key, payload)
		promptThread := cloneIssueThread(thread)
		promptThread.Events = append(promptThread.Events, eventRecord)
		record, err := m.run(ctx, promptThread, payload, event)
		if err != nil {
			m.recordRun(ctx, thread, record, "webhook")
			return Result{IssueID: issueID, Event: event}, err
		}
		m.appendEventRecord(ctx, thread, eventRecord, payload)
		m.recordRun(ctx, thread, record, "webhook")
		m.applyRevisitDecision(ctx, thread, record)
		return Result{IssueID: issueID, Event: event}, nil
	default:
		return Result{Ignored: true, Reason: "event ignored", IssueID: issueID, Event: event}, nil
	}
}

func (m *Manager) issueLock(issueID string) *sync.Mutex {
	value, _ := m.issueLocks.LoadOrStore(issueID, &sync.Mutex{})
	return value.(*sync.Mutex)
}

func (m *Manager) hasEvent(ctx context.Context, issueID, key string) bool {
	if strings.TrimSpace(key) == "" {
		return false
	}
	m.mu.Lock()
	thread := m.threads[issueID]
	m.mu.Unlock()
	if thread == nil {
		if loaded, ok := m.loadThread(ctx, issueID); ok {
			thread = loaded
			m.mu.Lock()
			m.threads[issueID] = thread
			m.mu.Unlock()
		}
	}
	if thread == nil {
		return false
	}
	for _, event := range thread.Events {
		if event.Key == key {
			return true
		}
	}
	return false
}

func webhookEventKey(payload map[string]any) string {
	data, err := json.Marshal(payload)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func (m *Manager) appendEvent(ctx context.Context, issueID, event, key string, payload map[string]any) *IssueThread {
	thread := m.threadForIssue(ctx, issueID, payload)
	eventRecord := m.newThreadEvent(event, key, payload)
	m.appendEventRecord(ctx, thread, eventRecord, payload)
	return thread
}

func (m *Manager) threadForIssue(ctx context.Context, issueID string, payload map[string]any) *IssueThread {
	now := time.Now().UTC()
	data, _ := json.Marshal(payload)

	m.mu.Lock()
	defer m.mu.Unlock()

	thread := m.threads[issueID]
	if thread == nil {
		if loaded, ok := m.loadThread(ctx, issueID); ok {
			thread = loaded
		} else {
			thread = &IssueThread{
				IssueID:     issueID,
				Status:      "active",
				CreatedAt:   now,
				UpdatedAt:   now,
				Events:      []ThreadEvent{},
				Runs:        []RunRecord{},
				LastPayload: data,
			}
		}
		m.threads[issueID] = thread
	}
	thread.Status = "active"
	thread.UpdatedAt = now
	thread.LastPayload = data
	return thread
}

func (m *Manager) newThreadEvent(event, key string, payload map[string]any) ThreadEvent {
	data, _ := json.Marshal(payload)
	comment := section(payload, "comment")
	return ThreadEvent{
		Type:    event,
		Key:     key,
		Actor:   actor(payload),
		Message: stringValue(comment, "comment_message"),
		Payload: data,
		At:      time.Now().UTC(),
	}
}

func (m *Manager) appendEventRecord(ctx context.Context, thread *IssueThread, eventRecord ThreadEvent, payload map[string]any) {
	m.mu.Lock()
	thread.Status = "active"
	thread.UpdatedAt = time.Now().UTC()
	thread.LastPayload, _ = json.Marshal(payload)
	thread.Events = append(thread.Events, eventRecord)
	m.upsertThread(ctx, thread)
	m.insertEvent(ctx, thread.IssueID, thread.Events[len(thread.Events)-1])
	m.mu.Unlock()

	log.Printf("seerr thread event recorded: issue=%s event=%s actor=%q events=%d", thread.IssueID, eventRecord.Type, eventRecord.Actor, len(thread.Events))
}

func cloneIssueThread(thread *IssueThread) *IssueThread {
	if thread == nil {
		return nil
	}
	clone := *thread
	clone.Events = append([]ThreadEvent(nil), thread.Events...)
	clone.Runs = append([]RunRecord(nil), thread.Runs...)
	clone.LastPayload = append(json.RawMessage(nil), thread.LastPayload...)
	return &clone
}

func (m *Manager) run(ctx context.Context, thread *IssueThread, payload map[string]any, event string) (RunRecord, error) {
	runCtx, cancel := context.WithTimeout(ctx, m.cfg.RunTimeout)
	defer cancel()

	start := time.Now().UTC()
	record := RunRecord{StartedAt: start}
	prompt := m.issuePromptContext(thread, payload, event)
	request := Request{
		Source:   "seerr_issue_" + event,
		ThreadID: "issue:" + thread.IssueID,
		Author:   actor(payload),
		Audience: "seerr_issue",
		Content:  prompt.Content,
	}
	progress := m.newSeerrProgressReporter(thread.IssueID, request)
	request.Progress = progress.callback(runCtx)
	log.Printf("seerr issue run started: issue=%s event=%s actor=%q prior_events=%d prior_runs=%d", thread.IssueID, event, request.Author, len(thread.Events), len(thread.Runs))
	if err := progress.start(runCtx); err != nil {
		log.Printf("seerr transient comment failed: issue=%s event=%s error=%v", thread.IssueID, event, err)
	}

	response, err := m.runner.Respond(runCtx, request)
	record.CompletedAt = time.Now().UTC()
	if err != nil {
		record.Error = err.Error()
		record.CompletionReason = "agent run failed"
		if m.cfg.SeerrTransientRunComments {
			_ = progress.postOrUpdate(runCtx, m.signedRunMessage("Die Prüfung ist fehlgeschlagen.", progress.latestTodos(), request))
		}
		log.Printf("seerr issue run failed: issue=%s event=%s duration=%s error=%v", thread.IssueID, event, record.CompletedAt.Sub(record.StartedAt).Round(time.Millisecond), err)
		return record, err
	}
	decision := parseIssueRunDecision(response)
	record.RevisitIn = decision.RevisitIn
	record.RevisitReason = decision.RevisitReason
	if decision.Action == "none" {
		if err := progress.delete(runCtx); err != nil {
			record.Error = err.Error()
			record.CompletionReason = "transient comment delete failed"
			return record, fmt.Errorf("delete transient issue comment: %w", err)
		}
		record.CompletionReason = "no public update needed"
		log.Printf("seerr issue run completed without public update: issue=%s event=%s duration=%s", thread.IssueID, event, record.CompletedAt.Sub(record.StartedAt).Round(time.Millisecond))
		return record, nil
	}
	comment := decision.Comment
	resolveIssue := decision.ResolveIssue
	if strings.TrimSpace(comment) == "" {
		err := fmt.Errorf("agent returned empty final comment")
		record.Error = err.Error()
		record.CompletionReason = "agent run returned empty comment"
		_ = progress.delete(runCtx)
		log.Printf("seerr issue run failed: issue=%s event=%s duration=%s error=%v", thread.IssueID, event, record.CompletedAt.Sub(record.StartedAt).Round(time.Millisecond), err)
		return record, err
	}
	if err := m.validateFinalIssueComment(comment); err != nil {
		record.Error = err.Error()
		record.CompletionReason = "agent final comment failed validation"
		_ = progress.delete(runCtx)
		log.Printf("seerr issue run failed validation: issue=%s event=%s duration=%s error=%v", thread.IssueID, event, record.CompletedAt.Sub(record.StartedAt).Round(time.Millisecond), err)
		return record, err
	}

	comment = progress.render(comment)
	if err := m.validateSignedFinalIssueComment(comment); err != nil {
		record.Error = err.Error()
		record.CompletionReason = "agent final comment failed validation"
		_ = progress.delete(runCtx)
		log.Printf("seerr issue run failed validation: issue=%s event=%s duration=%s error=%v", thread.IssueID, event, record.CompletedAt.Sub(record.StartedAt).Round(time.Millisecond), err)
		return record, err
	}
	record.FinalComment = comment
	record.Attribution = m.commentAttribution()
	log.Printf("seerr issue run completed: issue=%s event=%s duration=%s comment_bytes=%d", thread.IssueID, event, record.CompletedAt.Sub(record.StartedAt).Round(time.Millisecond), len(comment))
	if err := progress.postOrUpdate(runCtx, comment); err != nil {
		record.Error = err.Error()
		record.CompletionReason = "final comment failed"
		log.Printf("seerr final comment failed: issue=%s event=%s error=%v", thread.IssueID, event, err)
		return record, fmt.Errorf("post final issue comment: %w", err)
	}
	record.Posted = true
	record.CompletionReason = "final comment posted"
	log.Printf("seerr final comment posted: issue=%s event=%s attribution=%s", thread.IssueID, event, record.Attribution)
	if resolveIssue {
		if _, err := m.tools.ResolveIssue(runCtx, thread.IssueID); err != nil {
			record.Error = err.Error()
			record.CompletionReason = "issue resolve failed"
			log.Printf("seerr issue resolve failed: issue=%s event=%s error=%v", thread.IssueID, event, err)
			return record, fmt.Errorf("resolve issue: %w", err)
		}
		record.Resolved = true
		record.CompletionReason = "final comment posted and issue resolved"
		log.Printf("seerr issue resolved by harness: issue=%s event=%s", thread.IssueID, event)
	}
	return record, nil
}

func (m *Manager) recordRun(ctx context.Context, thread *IssueThread, record RunRecord, source string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	thread.Runs = append(thread.Runs, record)
	thread.Summary = buildIssueSummary(thread)
	thread.UpdatedAt = time.Now().UTC()
	m.upsertThread(ctx, thread)
	m.insertRun(ctx, thread.IssueID, record, source)
}

func (m *Manager) complete(ctx context.Context, thread *IssueThread, reason string) {
	now := time.Now().UTC()
	m.mu.Lock()
	thread.Status = "completed"
	thread.CompletedAt = &now
	thread.CompletionReason = reason
	thread.UpdatedAt = now
	thread.NextRevisitAt = nil
	thread.RevisitReason = ""
	m.mu.Unlock()

	m.upsertThread(ctx, thread)
	log.Printf("seerr issue completed: issue=%s reason=%q", thread.IssueID, reason)
}
