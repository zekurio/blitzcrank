package harness

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
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
		Skill:   "seerr-issue-solver",
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
		CreatedAt:        loaded.CreatedAt,
		UpdatedAt:        loaded.UpdatedAt,
		CompletedAt:      loaded.CompletedAt,
		CompletionReason: loaded.CompletionReason,
		LastPayload:      json.RawMessage(loaded.LastPayloadJSON),
	}
	for _, event := range loaded.Events {
		thread.Events = append(thread.Events, ThreadEvent{
			Type:    event.EventType,
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
	return thread, true
}

func (m *Manager) upsertThread(ctx context.Context, thread *IssueThread) {
	if m.store == nil {
		return
	}
	if err := m.store.UpsertIssueThread(ctx, store.IssueThread{
		IssueID:          thread.IssueID,
		Status:           thread.Status,
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

func (m *Manager) persist(thread *IssueThread) error {
	if err := os.MkdirAll(m.cfg.ThreadsDirectory, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(thread, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(m.cfg.ThreadsDirectory, "issue-"+thread.IssueID+".json")
	return os.WriteFile(path, data, 0o600)
}

func (m *Manager) issuePrompt(thread *IssueThread, payload map[string]any, event string) string {
	data, _ := json.MarshalIndent(payload, "", "  ")
	return fmt.Sprintf(`Jellyseerr issue workflow event: %s
Issue id: %s
Prior thread events: %d
Prior solver runs: %d

Use the tools to investigate the issue, apply safe fixes when appropriate, validate the result, and return exactly one final Jellyseerr issue comment body.

Required final comment:
- Write in German.
- Explain what caused the issue and what was done to fix it.
- Mention validation when a fix was verified.
- Do not include a signature/header; the harness adds a bracket header with the bot name and model.
- Keep it concise and readable as a Jellyseerr issue comment.

Webhook payload:
%s`, event, thread.IssueID, len(thread.Events), len(thread.Runs), string(data))
}

func (m *Manager) signedComment(comment string, request agent.Request) string {
	comment = strings.TrimSpace(comment)
	header := m.commentHeader(request)
	if strings.HasPrefix(comment, header) || strings.HasPrefix(comment, m.commentHeaderPrefix()) {
		return comment
	}
	return header + "\n\n" + comment
}

func (m *Manager) commentHeader(request ...agent.Request) string {
	name := strings.ToLower(strings.TrimSpace(m.cfg.SeerrBotDisplayName))
	if name == "" {
		name = "blitzcrank"
	}
	model := strings.TrimSpace(m.cfg.Model)
	if len(request) > 0 {
		if namer, ok := m.runner.(modelNamer); ok {
			if resolved := strings.TrimSpace(namer.ModelName(request[0])); resolved != "" {
				model = resolved
			}
		}
	}
	if model == "" {
		model = "unknown-model"
	}
	if strings.EqualFold(strings.TrimSpace(m.cfg.CodexServiceTier), "fast") {
		model += " fast"
	}
	return "[" + name + " w/ " + model + "]"
}

func (m *Manager) commentHeaderPrefix() string {
	name := strings.ToLower(strings.TrimSpace(m.cfg.SeerrBotDisplayName))
	if name == "" {
		name = "blitzcrank"
	}
	return "[" + name + " w/ "
}

func (m *Manager) commentAttribution() string {
	if m.cfg.SeerrBotUserID != "" {
		return "bot_user:" + m.cfg.SeerrBotUserID
	}
	return "signed:" + m.cfg.SeerrBotDisplayName
}

func (m *Manager) botAuthored(payload map[string]any) bool {
	comment := section(payload, "comment")
	username := stringValue(comment, "commentedBy_username")
	message := strings.TrimSpace(stringValue(comment, "comment_message"))
	if username != "" && strings.EqualFold(username, m.cfg.SeerrBotDisplayName) {
		return true
	}
	return strings.HasPrefix(message, m.commentHeaderPrefix())
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
