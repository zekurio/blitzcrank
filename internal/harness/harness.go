package harness

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"blitzcrank/internal/agent"
	"blitzcrank/internal/config"
	"blitzcrank/internal/store"
	"blitzcrank/internal/tools"
)

type Runner interface {
	Respond(context.Context, agent.Request) (string, error)
}

type modelNamer interface {
	ModelName(agent.Request) string
}

type Manager struct {
	cfg     config.Config
	runner  Runner
	tools   *tools.Registry
	store   *store.Store
	mu      sync.Mutex
	threads map[string]*IssueThread
}

type IssueThread struct {
	IssueID          string          `json:"issue_id"`
	Status           string          `json:"status"`
	CreatedAt        time.Time       `json:"created_at"`
	UpdatedAt        time.Time       `json:"updated_at"`
	CompletedAt      *time.Time      `json:"completed_at,omitempty"`
	CompletionReason string          `json:"completion_reason,omitempty"`
	Events           []ThreadEvent   `json:"events"`
	Runs             []RunRecord     `json:"runs"`
	LastPayload      json.RawMessage `json:"last_payload,omitempty"`
}

type ThreadEvent struct {
	Type    string          `json:"type"`
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
	Attribution      string    `json:"attribution"`
	Error            string    `json:"error,omitempty"`
	CompletionReason string    `json:"completion_reason,omitempty"`
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
	log.Printf("jellyseerr webhook classified: issue=%s event=%s notification=%q actor=%q", issueID, event, stringValue(payload, "notification_type"), actor(payload))
	if issueID == "" {
		return Result{Ignored: true, Reason: "payload has no issue_id", Event: event}, nil
	}
	if event == "unknown" {
		return Result{Ignored: true, Reason: "payload is not an issue workflow event", IssueID: issueID, Event: event}, nil
	}

	if event == "comment" && m.botAuthored(payload) {
		return Result{Ignored: true, Reason: "bot-authored comment ignored", IssueID: issueID, Event: event}, nil
	}

	thread := m.appendEvent(issueID, event, payload)
	switch event {
	case "resolved":
		m.complete(thread, "jellyseerr issue resolved")
		return Result{IssueID: issueID, Event: event}, nil
	case "comment", "reported", "reopened":
		if err := m.run(ctx, thread, payload, event); err != nil {
			return Result{IssueID: issueID, Event: event}, err
		}
		return Result{IssueID: issueID, Event: event}, nil
	default:
		return Result{Ignored: true, Reason: "event ignored", IssueID: issueID, Event: event}, nil
	}
}

func (m *Manager) appendEvent(issueID, event string, payload map[string]any) *IssueThread {
	now := time.Now().UTC()
	data, _ := json.Marshal(payload)
	comment := section(payload, "comment")

	m.mu.Lock()
	defer m.mu.Unlock()

	thread := m.threads[issueID]
	if thread == nil {
		if loaded, ok := m.loadThread(context.Background(), issueID); ok {
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
	thread.Events = append(thread.Events, ThreadEvent{
		Type:    event,
		Actor:   actor(payload),
		Message: stringValue(comment, "comment_message"),
		Payload: data,
		At:      now,
	})
	m.upsertThread(context.Background(), thread)
	m.insertEvent(context.Background(), thread.IssueID, thread.Events[len(thread.Events)-1])
	m.appendTrace("issues/issue-"+issueID+".jsonl", map[string]any{
		"type":    "webhook_event",
		"issue":   issueID,
		"event":   event,
		"actor":   actor(payload),
		"message": stringValue(comment, "comment_message"),
		"payload": payload,
		"at":      now.Format(time.RFC3339Nano),
	})
	log.Printf("jellyseerr thread event recorded: issue=%s event=%s actor=%q events=%d", issueID, event, actor(payload), len(thread.Events))
	return thread
}

func (m *Manager) run(ctx context.Context, thread *IssueThread, payload map[string]any, event string) error {
	runCtx, cancel := context.WithTimeout(ctx, m.cfg.RunTimeout)
	defer cancel()

	start := time.Now().UTC()
	record := RunRecord{StartedAt: start}
	prompt := m.issuePrompt(thread, payload, event)
	request := agent.Request{
		Source:  "jellyseerr_issue_" + event,
		Author:  actor(payload),
		Content: prompt,
	}
	log.Printf("jellyseerr issue run started: issue=%s event=%s actor=%q prior_events=%d prior_runs=%d", thread.IssueID, event, request.Author, len(thread.Events), len(thread.Runs))

	comment, err := m.runner.Respond(runCtx, request)
	record.CompletedAt = time.Now().UTC()
	if err != nil {
		record.Error = err.Error()
		record.CompletionReason = "agent run failed"
		m.recordRun(thread, record)
		log.Printf("jellyseerr issue run failed: issue=%s event=%s duration=%s error=%v", thread.IssueID, event, record.CompletedAt.Sub(record.StartedAt).Round(time.Millisecond), err)
		return err
	}
	if strings.TrimSpace(comment) == "" {
		err := fmt.Errorf("agent returned empty final comment")
		record.Error = err.Error()
		record.CompletionReason = "agent run returned empty comment"
		m.recordRun(thread, record)
		log.Printf("jellyseerr issue run failed: issue=%s event=%s duration=%s error=%v", thread.IssueID, event, record.CompletedAt.Sub(record.StartedAt).Round(time.Millisecond), err)
		return err
	}
	if err := m.validateFinalIssueComment(comment); err != nil {
		record.Error = err.Error()
		record.CompletionReason = "agent final comment failed validation"
		m.recordRun(thread, record)
		log.Printf("jellyseerr issue run failed validation: issue=%s event=%s duration=%s error=%v", thread.IssueID, event, record.CompletedAt.Sub(record.StartedAt).Round(time.Millisecond), err)
		return err
	}

	comment = m.signedComment(comment, request)
	record.FinalComment = comment
	record.Attribution = m.commentAttribution()
	log.Printf("jellyseerr issue run completed: issue=%s event=%s duration=%s comment_bytes=%d", thread.IssueID, event, record.CompletedAt.Sub(record.StartedAt).Round(time.Millisecond), len(comment))
	if _, err := m.tools.CommentIssue(runCtx, thread.IssueID, comment); err != nil {
		record.Error = err.Error()
		record.CompletionReason = "final comment failed"
		m.recordRun(thread, record)
		log.Printf("jellyseerr final comment failed: issue=%s event=%s error=%v", thread.IssueID, event, err)
		return fmt.Errorf("post final issue comment: %w", err)
	}
	record.Posted = true
	record.CompletionReason = "final comment posted"
	m.recordRun(thread, record)
	log.Printf("jellyseerr final comment posted: issue=%s event=%s attribution=%s", thread.IssueID, event, record.Attribution)
	return nil
}

func (m *Manager) recordRun(thread *IssueThread, record RunRecord) {
	m.mu.Lock()
	defer m.mu.Unlock()
	thread.Runs = append(thread.Runs, record)
	thread.UpdatedAt = time.Now().UTC()
	m.upsertThread(context.Background(), thread)
	m.insertRun(context.Background(), thread.IssueID, record, "webhook")
	m.appendTrace("issues/issue-"+thread.IssueID+".jsonl", map[string]any{
		"type":              "agent_run",
		"issue":             thread.IssueID,
		"started_at":        record.StartedAt.Format(time.RFC3339Nano),
		"completed_at":      record.CompletedAt.Format(time.RFC3339Nano),
		"final_comment":     record.FinalComment,
		"posted":            record.Posted,
		"attribution":       record.Attribution,
		"error":             record.Error,
		"completion_reason": record.CompletionReason,
	})
}

func (m *Manager) complete(thread *IssueThread, reason string) {
	now := time.Now().UTC()
	m.mu.Lock()
	thread.Status = "completed"
	thread.CompletedAt = &now
	thread.CompletionReason = reason
	thread.UpdatedAt = now
	m.mu.Unlock()

	m.upsertThread(context.Background(), thread)
	m.appendTrace("issues/issue-"+thread.IssueID+".jsonl", map[string]any{
		"type":              "issue_completed",
		"issue":             thread.IssueID,
		"completion_reason": reason,
		"at":                now.Format(time.RFC3339Nano),
	})
	log.Printf("jellyseerr issue completed: issue=%s reason=%q", thread.IssueID, reason)
	if err := m.persist(thread); err != nil {
		log.Printf("persist issue thread %s: %v", thread.IssueID, err)
	}
}

func classify(payload map[string]any) string {
	if _, ok := payload["issue"].(map[string]any); !ok {
		return "unknown"
	}
	text := strings.ToLower(strings.Join([]string{
		stringValue(payload, "notification_type"),
		stringValue(payload, "event"),
		stringValue(payload, "subject"),
	}, " "))
	switch {
	case strings.Contains(text, "comment"), strings.Contains(text, "kommentar"):
		return "comment"
	case strings.Contains(text, "resolved"), strings.Contains(text, "gelöst"), strings.Contains(text, "gelost"):
		return "resolved"
	case strings.Contains(text, "reopened"), strings.Contains(text, "wieder"):
		return "reopened"
	case strings.Contains(text, "reported"), strings.Contains(text, "gemeldet"), strings.Contains(text, "new"):
		return "reported"
	default:
		return "reported"
	}
}

func issueID(payload map[string]any) string {
	return stringValue(section(payload, "issue"), "issue_id")
}

func actor(payload map[string]any) string {
	for _, candidate := range []struct {
		section string
		key     string
	}{
		{"comment", "commentedBy_username"},
		{"issue", "reportedBy_username"},
		{"request", "requestedBy_username"},
	} {
		if value := stringValue(section(payload, candidate.section), candidate.key); value != "" {
			return value
		}
	}
	return "Jellyseerr"
}

func section(payload map[string]any, name string) map[string]any {
	value, _ := payload[name].(map[string]any)
	if value == nil {
		return map[string]any{}
	}
	return value
}

func stringValue(payload map[string]any, key string) string {
	value, _ := payload[key].(string)
	return strings.TrimSpace(value)
}
