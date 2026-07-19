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
	"unicode"

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
	cfg                config.Config
	runner             Runner
	tools              *tools.Registry
	store              *store.Store
	resolutionReviewer IssueResolutionReviewer
	resolutionMu       sync.Mutex
	pendingResolutions map[string]pendingIssueResolution
	mu                 sync.Mutex
	threads            map[string]*IssueThread
	issueLocks         sync.Map
}

type IssueResolutionReview struct {
	RunID          string
	Source         string
	ConversationID string
	ActorID        string
	Authority      string
	IssueID        string
	FinalComment   string
	AgentResponse  string
	CurrentState   string
	MutationPolicy string
}

type IssueResolutionDecision struct {
	Verdict        string
	Reason         string
	ConfirmationID string
}

type IssueResolutionReviewer interface {
	ReviewIssueResolution(context.Context, IssueResolutionReview) (IssueResolutionDecision, error)
}

type issueResolutionConfirmer interface {
	ConfirmIssueResolution(context.Context, string, string, string) error
}

type issueResolutionCompleter interface {
	CompleteIssueResolution(context.Context, string, bool)
}

type pendingIssueResolution struct {
	ConfirmationID string
	ActorID        string
	ConversationID string
	ExpiresAt      time.Time
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
		cfg:                cfg,
		runner:             runner,
		tools:              registry,
		store:              state,
		threads:            map[string]*IssueThread{},
		pendingResolutions: map[string]pendingIssueResolution{},
	}
}

func (m *Manager) SetIssueResolutionReviewer(reviewer IssueResolutionReviewer) {
	m.resolutionReviewer = reviewer
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
		var resolutionConfirmationConsumed bool
		if event == "comment" {
			resolutionConfirmationConsumed = m.confirmPendingResolution(ctx, thread, payload)
		}
		eventRecord := m.newThreadEvent(event, key, payload)
		promptThread := cloneIssueThread(thread)
		promptThread.Events = append(promptThread.Events, eventRecord)
		record, err := m.run(ctx, promptThread, payload, event, resolutionConfirmationConsumed)
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
	return ThreadEvent{
		Type:    event,
		Key:     key,
		Actor:   actor(payload),
		Message: currentAuthority(payload),
		Payload: data,
		At:      time.Now().UTC(),
	}
}

func (m *Manager) appendEventRecord(ctx context.Context, thread *IssueThread, eventRecord ThreadEvent, payload map[string]any) {
	m.mu.Lock()
	thread.Status = "active"
	thread.UpdatedAt = time.Now().UTC()
	// A revisit payload is synthetic and does not contain reporter identity.
	// Keep the last Seerr payload so later revisits retain that authority.
	if eventRecord.Type != "revisit" {
		thread.LastPayload, _ = json.Marshal(payload)
	}
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

func (m *Manager) run(ctx context.Context, thread *IssueThread, payload map[string]any, event string, resolutionConfirmationConsumed bool) (RunRecord, error) {
	runCtx, cancel := context.WithTimeout(ctx, m.cfg.RunTimeout)
	defer cancel()

	start := time.Now().UTC()
	record := RunRecord{StartedAt: start}
	prompt := m.issuePromptContext(thread, payload, event)
	request := Request{
		Source:         "seerr_issue_" + event,
		ThreadID:       "issue:" + thread.IssueID,
		RunID:          fmt.Sprintf("seerr-%s-%d", thread.IssueID, start.UnixNano()),
		Author:         actor(payload),
		ActorID:        trustedIssueActorID(thread, payload, event),
		Audience:       "seerr_issue",
		Content:        prompt.Content,
		Authority:      issueAuthority(thread, payload, event),
		MutationPolicy: issueMutationPolicy(thread, payload, event),
		MutationBudget: m.cfg.SeerrMutationBudget,
		Confirmation:   event == "comment" && !resolutionConfirmationConsumed && isExplicitIssueConfirmation(currentAuthority(payload)),
	}
	progress := m.newSeerrProgressReporter(thread.IssueID, request)
	request.Progress = progress.callback(runCtx)
	log.Printf("seerr issue run started: issue=%s event=%s actor=%q prior_events=%d prior_runs=%d", thread.IssueID, event, request.Author, len(thread.Events), len(thread.Runs))

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
	resolutionDecision := IssueResolutionDecision{}
	var resolutionReviewErr error
	if resolveIssue {
		currentState, stateErr := m.tools.GetIssue(runCtx, thread.IssueID)
		if stateErr != nil {
			resolutionReviewErr = fmt.Errorf("current Seerr issue state is unavailable for finalization review")
		} else {
			resolutionDecision, resolutionReviewErr = m.reviewIssueResolution(runCtx, IssueResolutionReview{
				RunID:          request.RunID,
				Source:         request.Source,
				ConversationID: request.ThreadID,
				ActorID:        request.ActorID,
				Authority:      request.Authority,
				IssueID:        thread.IssueID,
				FinalComment:   comment,
				AgentResponse:  response,
				CurrentState:   summarizeReviewEvidence(currentState),
				MutationPolicy: request.MutationPolicy,
			})
		}
		if resolutionReviewErr != nil {
			resolveIssue = false
			log.Printf("seerr issue resolution review failed: issue=%s event=%s error=%v", thread.IssueID, event, resolutionReviewErr)
		} else if !strings.EqualFold(strings.TrimSpace(resolutionDecision.Verdict), "approve") {
			resolveIssue = false
			if strings.EqualFold(strings.TrimSpace(resolutionDecision.Verdict), "needs_confirmation") {
				m.rememberPendingResolution(thread.IssueID, request, resolutionDecision)
				comment = "Soll ich dieses Seerr-Ticket jetzt als gelöst schließen?"
			}
			log.Printf("seerr issue resolution not approved: issue=%s event=%s verdict=%s reason=%q", thread.IssueID, event, resolutionDecision.Verdict, resolutionDecision.Reason)
		}
	}

	comment = progress.render(comment)
	if err := m.validateSignedFinalIssueComment(comment); err != nil {
		if resolveIssue {
			m.completeIssueResolutionReview(runCtx, request.RunID, false)
		}
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
		if resolveIssue {
			m.completeIssueResolutionReview(runCtx, request.RunID, false)
		}
		record.Error = err.Error()
		record.CompletionReason = "final comment failed"
		log.Printf("seerr final comment failed: issue=%s event=%s error=%v", thread.IssueID, event, err)
		return record, fmt.Errorf("post final issue comment: %w", err)
	}
	record.Posted = true
	record.CompletionReason = "final comment posted"
	if resolutionReviewErr != nil {
		record.Error = resolutionReviewErr.Error()
		record.CompletionReason = "final comment posted; issue resolution review failed"
	} else if decision.ResolveIssue && !resolveIssue {
		record.CompletionReason = "final comment posted; issue resolution review " + resolutionReviewStatus(resolutionDecision.Verdict)
	}
	log.Printf("seerr final comment posted: issue=%s event=%s attribution=%s", thread.IssueID, event, record.Attribution)
	if resolveIssue {
		if _, err := m.tools.ResolveIssue(runCtx, thread.IssueID); err != nil {
			m.completeIssueResolutionReview(runCtx, request.RunID, false)
			record.Error = err.Error()
			record.CompletionReason = "issue resolve failed"
			log.Printf("seerr issue resolve failed: issue=%s event=%s error=%v", thread.IssueID, event, err)
			return record, fmt.Errorf("resolve issue: %w", err)
		}
		resolvedState, err := m.tools.GetIssue(runCtx, thread.IssueID)
		if err != nil || !seerrIssueResolved(resolvedState) {
			m.completeIssueResolutionReview(runCtx, request.RunID, false)
			if err == nil {
				err = fmt.Errorf("fresh Seerr issue read did not confirm resolved status")
			}
			record.Error = err.Error()
			record.CompletionReason = "issue resolve validation failed"
			log.Printf("seerr issue resolve validation failed: issue=%s event=%s error=%v", thread.IssueID, event, err)
			return record, fmt.Errorf("validate resolved issue: %w", err)
		}
		m.completeIssueResolutionReview(runCtx, request.RunID, true)
		record.Resolved = true
		record.CompletionReason = "final comment posted and issue resolved"
		log.Printf("seerr issue resolved by harness: issue=%s event=%s", thread.IssueID, event)
	}
	return record, nil
}

func (m *Manager) completeIssueResolutionReview(ctx context.Context, runID string, validated bool) {
	if completer, ok := m.resolutionReviewer.(issueResolutionCompleter); ok {
		completer.CompleteIssueResolution(ctx, runID, validated)
	}
}

func seerrIssueResolved(value any) bool {
	object, ok := value.(map[string]any)
	if !ok {
		return false
	}
	switch status := object["status"].(type) {
	case string:
		return strings.EqualFold(strings.TrimSpace(status), "resolved") || strings.TrimSpace(status) == "2"
	case float64:
		return status == 2
	case json.Number:
		return status.String() == "2"
	case int:
		return status == 2
	case int64:
		return status == 2
	default:
		return false
	}
}

func summarizeReviewEvidence(value any) string {
	encoded, err := json.Marshal(sanitizeReviewEvidence(value, 0))
	if err != nil {
		return "[unavailable]"
	}
	const limit = 12 * 1024
	if len(encoded) > limit {
		encoded = append(encoded[:limit], []byte("... [truncated]")...)
	}
	return string(encoded)
}

func sanitizeReviewEvidence(value any, depth int) any {
	if depth > 6 {
		return "[truncated]"
	}
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, child := range typed {
			normalized := strings.NewReplacer("_", "", "-", "", ".", "").Replace(strings.ToLower(key))
			switch normalized {
			case "apikey", "token", "accesstoken", "refreshtoken", "authorization", "password", "secret", "cookie", "setcookie":
				out[key] = "[redacted]"
			default:
				out[key] = sanitizeReviewEvidence(child, depth+1)
			}
		}
		return out
	case []any:
		if len(typed) > 100 {
			typed = typed[:100]
		}
		out := make([]any, len(typed))
		for index, child := range typed {
			out[index] = sanitizeReviewEvidence(child, depth+1)
		}
		return out
	case string:
		const stringLimit = 4000
		if len(typed) > stringLimit {
			return typed[:stringLimit] + "... [truncated]"
		}
		return typed
	default:
		return value
	}
}

func (m *Manager) rememberPendingResolution(issueID string, request Request, decision IssueResolutionDecision) {
	confirmationID := strings.TrimSpace(decision.ConfirmationID)
	if confirmationID == "" {
		return
	}
	ttl := m.cfg.ConfirmationTTL
	if ttl <= 0 {
		ttl = 15 * time.Minute
	}
	m.resolutionMu.Lock()
	m.pendingResolutions[issueID] = pendingIssueResolution{
		ConfirmationID: confirmationID,
		ActorID:        request.ActorID,
		ConversationID: request.ThreadID,
		ExpiresAt:      time.Now().UTC().Add(ttl),
	}
	m.resolutionMu.Unlock()
}

func (m *Manager) confirmPendingResolution(ctx context.Context, thread *IssueThread, payload map[string]any) bool {
	if thread == nil || !isExplicitIssueConfirmation(currentAuthority(payload)) {
		return false
	}
	m.resolutionMu.Lock()
	pending, ok := m.pendingResolutions[thread.IssueID]
	if ok && time.Now().UTC().After(pending.ExpiresAt) {
		delete(m.pendingResolutions, thread.IssueID)
		ok = false
	}
	m.resolutionMu.Unlock()
	if !ok || pending.ActorID != trustedIssueActorID(thread, payload, "comment") {
		return false
	}
	confirmer, ok := m.resolutionReviewer.(issueResolutionConfirmer)
	if !ok {
		return false
	}
	if err := confirmer.ConfirmIssueResolution(ctx, pending.ConfirmationID, pending.ActorID, pending.ConversationID); err != nil {
		log.Printf("seerr issue resolution confirmation rejected: issue=%s actor=%s error=%v", thread.IssueID, pending.ActorID, err)
		return false
	}
	m.resolutionMu.Lock()
	delete(m.pendingResolutions, thread.IssueID)
	m.resolutionMu.Unlock()
	return true
}

func isExplicitIssueConfirmation(value string) bool {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.Map(func(character rune) rune {
		if unicode.IsPunct(character) {
			return ' '
		}
		return character
	}, value)
	value = strings.Join(strings.Fields(value), " ")
	switch value {
	case "ja", "ja bitte", "yes", "yes please", "ok", "okay", "bitte", "mach das", "tu es", "do it", "please", "please do", "bitte schließen", "bitte schliessen", "ticket schließen", "ticket schliessen", "resolve it", "close it":
		return true
	default:
		return false
	}
}

func (m *Manager) reviewIssueResolution(ctx context.Context, request IssueResolutionReview) (IssueResolutionDecision, error) {
	if m.resolutionReviewer == nil {
		return IssueResolutionDecision{Verdict: "deny", Reason: "resolution reviewer is not configured"}, nil
	}
	return m.resolutionReviewer.ReviewIssueResolution(ctx, request)
}

func resolutionReviewStatus(verdict string) string {
	switch strings.ToLower(strings.TrimSpace(verdict)) {
	case "needs_confirmation":
		return "needs confirmation"
	case "deny":
		return "denied"
	default:
		return "not approved"
	}
}

func issueAuthority(thread *IssueThread, payload map[string]any, event string) string {
	if event == "revisit" {
		return latestReporterAuthority(thread)
	}
	if authority := currentAuthority(payload); authority != "" {
		return authority
	}
	if thread == nil {
		return ""
	}
	for index := len(thread.Events) - 1; index >= 0; index-- {
		event := thread.Events[index]
		if strings.EqualFold(strings.TrimSpace(event.Actor), "blitzcrank") {
			continue
		}
		if message := strings.TrimSpace(event.Message); message != "" {
			return message
		}
	}
	return ""
}

func issueMutationPolicy(thread *IssueThread, payload map[string]any, event string) string {
	if event == "revisit" && latestReporterAuthority(thread) != "" {
		return "issue_report_and_reporter_comments"
	}
	if reporterAuthored(payload) {
		return "issue_report_and_reporter_comments"
	}
	return "read_only"
}

func trustedIssueActorID(thread *IssueThread, payload map[string]any, event string) string {
	if event == "revisit" {
		if previous := lastIssuePayload(thread); previous != nil {
			return reporterID(previous)
		}
	}
	if reporterAuthored(payload) {
		return reporterID(payload)
	}
	return actorID(payload)
}

func latestReporterAuthority(thread *IssueThread) string {
	previous := lastIssuePayload(thread)
	reporter := reporterName(previous)
	if thread == nil || reporter == "" {
		return ""
	}
	for index := len(thread.Events) - 1; index >= 0; index-- {
		event := thread.Events[index]
		if !strings.EqualFold(strings.TrimSpace(event.Actor), reporter) {
			continue
		}
		message := strings.TrimSpace(event.Message)
		if message == "" && len(event.Payload) > 0 {
			var payload map[string]any
			if json.Unmarshal(event.Payload, &payload) == nil {
				message = currentAuthority(payload)
			}
		}
		if message != "" {
			return message
		}
	}
	return ""
}

func lastIssuePayload(thread *IssueThread) map[string]any {
	if thread == nil || len(thread.LastPayload) == 0 {
		return nil
	}
	var payload map[string]any
	if json.Unmarshal(thread.LastPayload, &payload) != nil {
		return nil
	}
	return payload
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
