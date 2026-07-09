package review

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type Options struct {
	ReviewTimeout    time.Duration
	RunTokenTTL      time.Duration
	ApprovalTTL      time.Duration
	ConfirmationTTL  time.Duration
	ReviewerCapacity int
	Audit            AuditSink
	Now              func() time.Time
	Random           io.Reader
}

type Broker struct {
	reviewer Reviewer
	options  Options
	sem      chan struct{}

	mu        sync.Mutex
	runs      map[string]*runState
	ledgers   map[string]*runLedger
	approvals map[string]approvalState
	pending   map[string]PendingConfirmation
	grants    map[string]confirmationGrant
	listener  net.Listener
	server    *http.Server
	brokerURL string
	closed    bool
}

type runState struct {
	context   RunContext
	expiresAt time.Time
	ledger    *runLedger
}

type runLedger struct {
	approved  int
	prior     []PriorMutation
	budget    int
	expiresAt time.Time
}

type approvalState struct {
	runToken       string
	proposalHash   string
	classification Classification
	expiresAt      time.Time
	mutationIndex  int
	confirmed      bool
}

type confirmationGrant struct {
	confirmedAt time.Time
	expiresAt   time.Time
}

func NewBroker(reviewer Reviewer, options Options) *Broker {
	if options.ReviewTimeout <= 0 {
		options.ReviewTimeout = 15 * time.Second
	}
	if options.RunTokenTTL <= 0 {
		options.RunTokenTTL = 10 * time.Minute
	}
	if options.ApprovalTTL <= 0 {
		options.ApprovalTTL = 30 * time.Second
	}
	if options.ConfirmationTTL <= 0 {
		options.ConfirmationTTL = 15 * time.Minute
	}
	if options.ReviewerCapacity <= 0 {
		options.ReviewerCapacity = 1
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.Random == nil {
		options.Random = rand.Reader
	}
	return &Broker{
		reviewer:  reviewer,
		options:   options,
		sem:       make(chan struct{}, options.ReviewerCapacity),
		runs:      make(map[string]*runState),
		ledgers:   make(map[string]*runLedger),
		approvals: make(map[string]approvalState),
		pending:   make(map[string]PendingConfirmation),
		grants:    make(map[string]confirmationGrant),
	}
}

func (b *Broker) Start(ctx context.Context) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.listener != nil {
		return nil
	}
	if b.closed {
		return fmt.Errorf("review broker is closed")
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("listen for mutation reviews: %w", err)
	}
	b.listener = listener
	b.brokerURL = "http://" + listener.Addr().String()
	b.server = &http.Server{
		Handler:           b.routes(),
		ReadHeaderTimeout: 2 * time.Second,
		ReadTimeout:       b.options.ReviewTimeout + 2*time.Second,
		WriteTimeout:      b.options.ReviewTimeout + 2*time.Second,
		IdleTimeout:       30 * time.Second,
	}
	server := b.server
	go func() {
		_ = server.Serve(listener)
	}()
	go func() {
		<-ctx.Done()
		_ = b.Close()
	}()
	return nil
}

func (b *Broker) Close() error {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return nil
	}
	b.closed = true
	server := b.server
	b.runs = make(map[string]*runState)
	b.ledgers = make(map[string]*runLedger)
	b.approvals = make(map[string]approvalState)
	b.pending = make(map[string]PendingConfirmation)
	b.grants = make(map[string]confirmationGrant)
	b.mu.Unlock()
	if server == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("stop mutation review broker: %w", err)
	}
	return nil
}

func (b *Broker) URL() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.brokerURL
}

func (b *Broker) AuthorizeRun(run RunContext) (Authorization, error) {
	run, err := normalizeRunContext(run)
	if err != nil {
		return Authorization{}, err
	}
	token, err := b.randomToken(32)
	if err != nil {
		return Authorization{}, fmt.Errorf("create review run token: %w", err)
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.listener == nil || b.closed {
		return Authorization{}, fmt.Errorf("review broker is not running")
	}
	b.pruneLocked(b.now())
	now := b.now()
	expiresAt := now.Add(b.options.RunTokenTTL)
	key := runLedgerKey(run)
	ledger, ok := b.ledgers[key]
	if ok && ledger.budget != run.Budget {
		return Authorization{}, fmt.Errorf("follow-up mutation budget %d does not match original budget %d", run.Budget, ledger.budget)
	}
	if !ok {
		ledger = &runLedger{budget: run.Budget}
		b.ledgers[key] = ledger
	}
	ledger.expiresAt = expiresAt
	b.runs[token] = &runState{context: run, expiresAt: expiresAt, ledger: ledger}
	return Authorization{BrokerURL: b.brokerURL, Token: token, ExpiresAt: expiresAt}, nil
}

func (b *Broker) AuthorizeFollowup(run RunContext) (Authorization, error) {
	return b.AuthorizeRun(run)
}

func (b *Broker) RevokeRun(token string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.runs, token)
	for approvalToken, approval := range b.approvals {
		if approval.runToken == token {
			delete(b.approvals, approvalToken)
		}
	}
}

func (b *Broker) ReviewMutation(ctx context.Context, runToken string, proposal Proposal) (Decision, error) {
	decision, err := b.review(ctx, runToken, proposal)
	if err != nil || !decision.Approved() {
		return decision, err
	}
	if err := b.consume(runToken, decision.ApprovalToken, proposal); err != nil {
		return Decision{}, err
	}
	decision.ApprovalToken = ""
	return decision, nil
}

func (b *Broker) RecordExecution(runToken, proposalHash, status string, validationTargets []string) error {
	proposalHash = strings.TrimSpace(proposalHash)
	status = strings.ToLower(strings.TrimSpace(status))
	if proposalHash == "" {
		return fmt.Errorf("proposal_hash is required")
	}
	if status != ExecutionSucceeded && status != ExecutionFailed && status != ExecutionUnknown {
		return fmt.Errorf("execution status must be succeeded, failed, or unknown")
	}
	targets, err := normalizeValidationTargets(validationTargets)
	if err != nil {
		return err
	}
	if status == ExecutionSucceeded && len(targets) == 0 {
		return fmt.Errorf("successful execution requires an exact validation target")
	}
	if status != ExecutionSucceeded && len(targets) != 0 {
		return fmt.Errorf("validation targets are only accepted for successful execution")
	}
	now := b.now()
	b.mu.Lock()
	b.pruneLocked(now)
	run, ok := b.runs[runToken]
	if !ok {
		b.mu.Unlock()
		return ErrUnauthorized
	}
	for index := range run.ledger.prior {
		prior := &run.ledger.prior[index]
		if prior.ProposalHash != proposalHash {
			continue
		}
		if prior.Execution != ExecutionPending {
			b.mu.Unlock()
			return fmt.Errorf("mutation execution was already reported")
		}
		if status == ExecutionSucceeded && !validationTargetsAllowed(*prior, targets) {
			b.mu.Unlock()
			return fmt.Errorf("validation target is not valid for the approved mutation")
		}
		if sink, ok := b.options.Audit.(ExecutionAuditSink); ok {
			auditCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			err := sink.RecordMutationExecution(auditCtx, ExecutionAuditRecord{
				ProposalHash: proposalHash, RunID: run.context.RunID, Status: status, ExecutedAt: now,
			})
			cancel()
			if err != nil {
				b.mu.Unlock()
				return fmt.Errorf("record mutation execution audit: %w", err)
			}
		}
		prior.Execution = status
		prior.ExecutedAt = now
		prior.ValidationTargets = targets
		b.mu.Unlock()
		return nil
	}
	b.mu.Unlock()
	return fmt.Errorf("approved proposal was not consumed")
}

func validationTargetsAllowed(prior PriorMutation, targets []string) bool {
	if len(targets) != 1 {
		return false
	}
	target := targets[0]
	path := prior.proposalPath
	switch {
	case prior.Capability == "jellyfin.metadata_refresh":
		index := strings.Index(strings.ToLower(path), "/refresh")
		return index > 0 && target == path[:index]
	case strings.HasSuffix(prior.Capability, ".queue_cleanup") || strings.HasSuffix(prior.Capability, ".queue_rejection_cleanup") || strings.HasSuffix(prior.Capability, ".blocklist_delete"):
		if index := strings.IndexByte(path, '?'); index >= 0 {
			path = path[:index]
		}
		return target == path
	case strings.HasSuffix(prior.Capability, ".queue_grab"):
		parts := strings.Split(strings.Trim(path, "/"), "/")
		return len(parts) == 5 && parts[2] == "queue" && parts[3] == "grab" && target == "/api/v3/queue/"+parts[4]
	case strings.HasPrefix(prior.Capability, "sonarr.") || strings.HasPrefix(prior.Capability, "radarr."):
		parts := strings.Split(strings.Trim(target, "/"), "/")
		return len(parts) == 4 && parts[0] == "api" && parts[1] == "v3" && parts[2] == "command" && positiveDecimal(parts[3])
	case prior.Capability == "seerr.media_request":
		parts := strings.Split(strings.Trim(target, "/"), "/")
		return len(parts) == 4 && parts[0] == "api" && parts[1] == "v1" && parts[2] == "request" && positiveDecimal(parts[3])
	case prior.Capability == "seerr.issue_resolve":
		return strings.TrimSuffix(path, "/resolved") == target
	default:
		return false
	}
}

func positiveDecimal(value string) bool {
	if value == "" {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return false
		}
	}
	return value != "0"
}

func (b *Broker) RecordValidation(runToken, proposalHash, service, path, outcome string) error {
	proposalHash = strings.TrimSpace(proposalHash)
	service = strings.ToLower(strings.TrimSpace(service))
	path = strings.TrimSpace(path)
	outcome = strings.ToLower(strings.TrimSpace(outcome))
	if proposalHash == "" || service == "" || path == "" || !strings.HasPrefix(path, "/") {
		return fmt.Errorf("proposal_hash, service, and service-relative path are required")
	}
	if outcome != ValidationConfirmed && outcome != ValidationNotConfirmed {
		return fmt.Errorf("validation outcome must be confirmed or not_confirmed")
	}
	now := b.now()
	b.mu.Lock()
	b.pruneLocked(now)
	run, ok := b.runs[runToken]
	if !ok {
		b.mu.Unlock()
		return ErrUnauthorized
	}
	for index := range run.ledger.prior {
		prior := &run.ledger.prior[index]
		if prior.ProposalHash != proposalHash {
			continue
		}
		if prior.Execution != ExecutionSucceeded {
			b.mu.Unlock()
			return fmt.Errorf("only a successful execution can be validated")
		}
		if prior.Service != service || !containsString(prior.ValidationTargets, path) {
			b.mu.Unlock()
			return fmt.Errorf("observation does not match the exact validation target")
		}
		if sink, ok := b.options.Audit.(ValidationAuditSink); ok {
			auditCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			err := sink.RecordMutationValidation(auditCtx, ValidationAuditRecord{
				ProposalHash: proposalHash, RunID: run.context.RunID, Service: service, Outcome: outcome, ObservedAt: now,
			})
			cancel()
			if err != nil {
				b.mu.Unlock()
				return fmt.Errorf("record mutation validation audit: %w", err)
			}
		}
		prior.ObservedAt = now
		if outcome == ValidationConfirmed {
			prior.ValidatedAt = now
		}
		b.mu.Unlock()
		return nil
	}
	b.mu.Unlock()
	return fmt.Errorf("proposal hash is not part of this run")
}

func normalizeValidationTargets(values []string) ([]string, error) {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || !strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") || strings.ContainsAny(value, "\r\n#?") {
			return nil, fmt.Errorf("validation target must be a service-relative path")
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result, nil
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func (b *Broker) PendingFor(actorID, conversationID string) []PendingConfirmation {
	actorID = strings.TrimSpace(actorID)
	conversationID = strings.TrimSpace(conversationID)
	b.mu.Lock()
	defer b.mu.Unlock()
	b.pruneLocked(b.now())
	var pending []PendingConfirmation
	for _, candidate := range b.pending {
		if candidate.ActorID == actorID && candidate.ConversationID == conversationID {
			pending = append(pending, candidate)
		}
	}
	return pending
}

func (b *Broker) ConfirmLatest(actorID, conversationID string) error {
	actorID = strings.TrimSpace(actorID)
	conversationID = strings.TrimSpace(conversationID)
	if actorID == "" || conversationID == "" {
		return fmt.Errorf("actor_id and conversation_id are required")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
	b.pruneLocked(now)
	var match *PendingConfirmation
	for _, candidate := range b.pending {
		if candidate.ActorID != actorID || candidate.ConversationID != conversationID {
			continue
		}
		candidate := candidate
		if match != nil && match.ActionKey != candidate.ActionKey {
			return fmt.Errorf("multiple pending mutation confirmations require an explicit selection")
		}
		match = &candidate
	}
	if match == nil {
		return fmt.Errorf("no pending mutation confirmation for actor and conversation")
	}
	b.confirmLocked(*match, now)
	return nil
}

func (b *Broker) Confirm(id, actorID, conversationID string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
	b.pruneLocked(now)
	pending, ok := b.pending[strings.TrimSpace(id)]
	if !ok {
		return fmt.Errorf("pending mutation confirmation not found or expired")
	}
	if pending.ActorID != strings.TrimSpace(actorID) || pending.ConversationID != strings.TrimSpace(conversationID) {
		return ErrUnauthorized
	}
	b.confirmLocked(pending, now)
	return nil
}

func (b *Broker) confirmLocked(pending PendingConfirmation, now time.Time) {
	key := confirmationKey(pending.Source, pending.ActorID, pending.ConversationID, pending.ActionKey)
	b.grants[key] = confirmationGrant{confirmedAt: now, expiresAt: now.Add(b.options.ConfirmationTTL)}
	for id, candidate := range b.pending {
		if candidate.Source == pending.Source && candidate.ActorID == pending.ActorID && candidate.ConversationID == pending.ConversationID && candidate.ActionKey == pending.ActionKey {
			delete(b.pending, id)
		}
	}
}

func (b *Broker) review(ctx context.Context, runToken string, proposal Proposal) (Decision, error) {
	startedAt := b.now()
	normalized, err := normalizeProposal(proposal)
	if err != nil {
		return Decision{}, err
	}
	classification, err := classifySanitized(normalized)
	if err != nil {
		return b.policyDecision(ctx, runToken, normalized, Classification{}, startedAt, "policy_denied", err), nil
	}

	b.mu.Lock()
	b.pruneLocked(startedAt)
	run, ok := b.runs[runToken]
	if !ok {
		b.mu.Unlock()
		return Decision{}, ErrUnauthorized
	}
	runContext := run.context
	proposalHash := bindingHash(runContext, normalized)
	mutationIndex := run.ledger.approved + 1
	prior := append([]PriorMutation(nil), run.ledger.prior...)
	if err := mutationAllowedForRun(runContext, classification); err != nil {
		b.mu.Unlock()
		return b.policyDecisionKnown(ctx, runContext, normalized, proposalHash, classification, mutationIndex, startedAt, "capability_denied", err), nil
	}
	if !hasCurrentServiceEvidence(normalized) {
		b.mu.Unlock()
		err := fmt.Errorf("a successful current GET from %s is required before mutation review", normalized.Service)
		return b.policyDecisionKnown(ctx, runContext, normalized, proposalHash, classification, mutationIndex, startedAt, "evidence_required", err), nil
	}
	if run.ledger.approved >= run.ledger.budget {
		b.mu.Unlock()
		return b.policyDecisionKnown(ctx, runContext, normalized, proposalHash, classification, mutationIndex, startedAt, "budget_exhausted", ErrBudgetExceeded), nil
	}
	if err := b.freshReadRequiredLocked(runToken, run); err != nil {
		b.mu.Unlock()
		return b.policyDecisionKnown(ctx, runContext, normalized, proposalHash, classification, mutationIndex, startedAt, "validation_required", err), nil
	}
	action := actionKey(classification, normalized)
	grantKey := confirmationKey(runContext.Source, runContext.ActorID, runContext.ConversationID, action)
	grant, confirmed := b.grants[grantKey]
	b.mu.Unlock()

	request := ReviewRequest{
		Context:      runContext,
		Proposal:     normalized,
		ProposalHash: proposalHash,
		Baseline:     classification,
		Prior:        prior,
	}
	if confirmed {
		request.Confirmation = &ConfirmationContext{ConfirmedAt: grant.confirmedAt, ActionKey: action}
	}
	response, reviewErr := b.callReviewer(ctx, request)
	if reviewErr != nil {
		decision := Decision{
			Verdict:      VerdictDeny,
			Reason:       "The independent mutation reviewer was unavailable; no mutation was authorized.",
			OutcomeCode:  "reviewer_failure",
			Risk:         classification.Risk,
			Capability:   classification.Capability,
			ProposalHash: proposalHash,
		}
		b.recordAudit(ctx, AuditRecord{
			ProposalHash: proposalHash, RunID: runContext.RunID, Source: runContext.Source,
			ActorID: runContext.ActorID, ConversationID: runContext.ConversationID,
			Service: normalized.Service, Method: normalized.Method, Capability: classification.Capability,
			OutcomeCode: decision.OutcomeCode, Risk: classification.Risk, Verdict: decision.Verdict,
			MutationIndex: mutationIndex, Confirmed: confirmed, ReviewedAt: startedAt,
			Duration: b.now().Sub(startedAt), Error: "reviewer unavailable",
		})
		return decision, nil
	}
	response = enforceAuthority(runContext, classification, confirmed, response)

	decision := Decision{
		Verdict:      response.Verdict,
		Reason:       response.Reason,
		Risk:         classification.Risk,
		Capability:   classification.Capability,
		ProposalHash: proposalHash,
	}
	switch response.Verdict {
	case VerdictApprove:
		decision.OutcomeCode = "approved"
		approvalToken, tokenErr := b.randomToken(24)
		if tokenErr != nil {
			decision.Verdict = VerdictDeny
			decision.OutcomeCode = "authorization_failure"
			decision.Reason = "The exact mutation could not be authorized."
			break
		}
		b.mu.Lock()
		b.pruneLocked(b.now())
		current, stillAuthorized := b.runs[runToken]
		if !stillAuthorized || current.context.RunID != runContext.RunID {
			b.mu.Unlock()
			return Decision{}, ErrUnauthorized
		}
		if current.ledger.approved >= current.ledger.budget {
			b.mu.Unlock()
			decision.Verdict = VerdictDeny
			decision.OutcomeCode = "budget_exhausted"
			decision.Reason = "The mutation budget for this run is exhausted."
			break
		}
		if err := b.freshReadRequiredLocked(runToken, current); err != nil {
			b.mu.Unlock()
			decision.Verdict = VerdictDeny
			decision.OutcomeCode = "validation_required"
			decision.Reason = "A fresh read is required after the prior mutation."
			break
		}
		current.ledger.approved++
		mutationIndex = current.ledger.approved
		b.approvals[approvalToken] = approvalState{
			runToken: runToken, proposalHash: proposalHash,
			classification: classification, expiresAt: b.now().Add(b.options.ApprovalTTL),
			mutationIndex: mutationIndex, confirmed: confirmed,
		}
		if confirmed {
			delete(b.grants, grantKey)
		}
		b.mu.Unlock()
		decision.ApprovalToken = approvalToken
	case VerdictNeedsConfirmation:
		if sourceFamily(runContext.Source) == "automation" {
			decision.Verdict = VerdictDeny
			decision.OutcomeCode = "manual_review_required"
			decision.Reason = "Automations cannot confirm interactively; this mutation requires manual review."
			break
		}
		decision.OutcomeCode = "needs_confirmation"
		pending, pendingErr := b.addPending(runContext, action, classification.Capability)
		if pendingErr != nil {
			decision.Verdict = VerdictDeny
			decision.OutcomeCode = "authorization_failure"
			decision.Reason = "A confirmation request could not be registered."
			break
		}
		decision.Confirmation = &pending
	case VerdictDeny:
		decision.OutcomeCode = "reviewer_denied"
	default:
		decision.Verdict = VerdictDeny
		decision.OutcomeCode = "reviewer_invalid"
		decision.Reason = "The independent reviewer returned an invalid verdict."
	}

	auditErr := b.recordAudit(ctx, AuditRecord{
		ProposalHash: proposalHash, RunID: runContext.RunID, Source: runContext.Source,
		ActorID: runContext.ActorID, ConversationID: runContext.ConversationID,
		Service: normalized.Service, Method: normalized.Method, Capability: classification.Capability,
		OutcomeCode: decision.OutcomeCode, Risk: classification.Risk, Verdict: decision.Verdict,
		MutationIndex: mutationIndex, Confirmed: confirmed, ReviewedAt: startedAt,
		Duration: b.now().Sub(startedAt),
	})
	if auditErr != nil && decision.Approved() {
		b.mu.Lock()
		delete(b.approvals, decision.ApprovalToken)
		b.mu.Unlock()
		decision.Verdict = VerdictDeny
		decision.OutcomeCode = "audit_failure"
		decision.Reason = "The mutation review could not be recorded; no mutation was authorized."
		decision.ApprovalToken = ""
	}
	return decision, nil
}

// freshReadRequiredLocked prevents a second mutation from being authorized
// until every earlier mutation has been executed and validated. An approval
// not yet consumed is also blocking: it may still become a mutation while the
// independent reviewer is evaluating this proposal.
func (b *Broker) freshReadRequiredLocked(runToken string, run *runState) error {
	for _, approval := range b.approvals {
		if approval.runToken == runToken {
			return fmt.Errorf("fresh read required after outstanding approved mutation")
		}
	}
	for _, previous := range run.ledger.prior {
		if previous.Execution == ExecutionFailed {
			continue
		}
		if previous.Execution != ExecutionSucceeded || previous.ValidatedAt.IsZero() {
			return fmt.Errorf("fresh read required after prior mutation %s", previous.ProposalHash)
		}
	}
	return nil
}

func hasCurrentServiceEvidence(proposal SanitizedProposal) bool {
	for _, evidence := range proposal.Evidence {
		if strings.EqualFold(evidence.Service, proposal.Service) && strings.EqualFold(evidence.Method, "GET") && strings.HasPrefix(evidence.Path, "/") && strings.TrimSpace(evidence.Summary) != "" {
			return true
		}
	}
	return false
}

func (b *Broker) policyDecision(ctx context.Context, runToken string, proposal SanitizedProposal, classification Classification, startedAt time.Time, outcome string, policyErr error) Decision {
	b.mu.Lock()
	b.pruneLocked(startedAt)
	run, ok := b.runs[runToken]
	if !ok {
		b.mu.Unlock()
		return Decision{Verdict: VerdictDeny, OutcomeCode: "unauthorized", Reason: "Mutation review authorization is invalid."}
	}
	runContext := run.context
	proposalHash := bindingHash(runContext, proposal)
	mutationIndex := run.ledger.approved + 1
	b.mu.Unlock()
	return b.policyDecisionKnown(ctx, runContext, proposal, proposalHash, classification, mutationIndex, startedAt, outcome, policyErr)
}

func (b *Broker) policyDecisionKnown(ctx context.Context, run RunContext, proposal SanitizedProposal, proposalHash string, classification Classification, mutationIndex int, startedAt time.Time, outcome string, policyErr error) Decision {
	decision := Decision{
		Verdict: VerdictDeny, Reason: "The proposed mutation is not authorized by deterministic policy.",
		OutcomeCode: outcome, Risk: classification.Risk, Capability: classification.Capability,
		ProposalHash: proposalHash,
	}
	b.recordAudit(ctx, AuditRecord{
		ProposalHash: proposalHash, RunID: run.RunID, Source: run.Source, ActorID: run.ActorID,
		ConversationID: run.ConversationID, Service: proposal.Service, Method: proposal.Method,
		Capability: classification.Capability, OutcomeCode: outcome, Risk: classification.Risk,
		Verdict: VerdictDeny, MutationIndex: mutationIndex, ReviewedAt: startedAt,
		Duration: b.now().Sub(startedAt),
	})
	return decision
}

func (b *Broker) callReviewer(ctx context.Context, request ReviewRequest) (ReviewResponse, error) {
	if b.reviewer == nil {
		return ReviewResponse{}, fmt.Errorf("reviewer is not configured")
	}
	reviewCtx, cancel := context.WithTimeout(ctx, b.options.ReviewTimeout)
	defer cancel()
	select {
	case b.sem <- struct{}{}:
		defer func() { <-b.sem }()
	case <-reviewCtx.Done():
		return ReviewResponse{}, reviewCtx.Err()
	}
	response, err := b.reviewer.Review(reviewCtx, request)
	if err != nil {
		return ReviewResponse{}, err
	}
	response.Reason = strings.TrimSpace(response.Reason)
	if response.Reason == "" {
		return ReviewResponse{}, fmt.Errorf("reviewer reason is empty")
	}
	switch response.AuthorityBasis {
	case AuthorityPassiveCorrection, AuthorityExplicitIntent, AuthorityConfirmedIntent,
		AuthorityTrustedAutomation, AuthorityInsufficient:
	default:
		return ReviewResponse{}, fmt.Errorf("invalid reviewer authority basis %q", response.AuthorityBasis)
	}
	switch response.Verdict {
	case VerdictApprove, VerdictDeny, VerdictNeedsConfirmation:
		return response, nil
	default:
		return ReviewResponse{}, fmt.Errorf("invalid reviewer verdict %q", response.Verdict)
	}
}

func enforceAuthority(run RunContext, classification Classification, confirmed bool, response ReviewResponse) ReviewResponse {
	if response.Verdict != VerdictApprove {
		if confirmed && response.Verdict == VerdictNeedsConfirmation {
			response.Verdict = VerdictDeny
			response.AuthorityBasis = AuthorityInsufficient
			response.Reason = "The confirmed action still lacks sufficient evidence or authority."
		}
		return response
	}
	family := sourceFamily(run.Source)
	if family == "automation" {
		if response.AuthorityBasis != AuthorityTrustedAutomation || strings.TrimSpace(run.Authority) == "" {
			return ReviewResponse{
				Verdict:        VerdictDeny,
				AuthorityBasis: AuthorityInsufficient,
				Reason:         "The proposal is not authorized by the trusted automation definition.",
			}
		}
		return response
	}
	if family == "discord" || family == "seerr" {
		if strings.TrimSpace(run.Authority) == "" {
			return ReviewResponse{
				Verdict:        VerdictNeedsConfirmation,
				AuthorityBasis: AuthorityInsufficient,
				Reason:         "No trusted requester authority was supplied for this action.",
			}
		}
		if classification.Risk == RiskMedium || classification.Risk == RiskHigh {
			required := AuthorityExplicitIntent
			if confirmed {
				required = AuthorityConfirmedIntent
			}
			if response.AuthorityBasis != required {
				verdict := VerdictNeedsConfirmation
				if confirmed {
					verdict = VerdictDeny
				}
				return ReviewResponse{
					Verdict:        verdict,
					AuthorityBasis: AuthorityInsufficient,
					Reason:         "Medium/high-risk mutations require explicit requester intent or a matching fresh confirmation.",
				}
			}
			return response
		}
		switch response.AuthorityBasis {
		case AuthorityPassiveCorrection, AuthorityExplicitIntent, AuthorityConfirmedIntent:
			return response
		default:
			return ReviewResponse{
				Verdict:        VerdictNeedsConfirmation,
				AuthorityBasis: AuthorityInsufficient,
				Reason:         "The requester authority is insufficient for this mutation.",
			}
		}
	}
	if response.AuthorityBasis != AuthorityExplicitIntent && response.AuthorityBasis != AuthorityConfirmedIntent {
		return ReviewResponse{
			Verdict:        VerdictDeny,
			AuthorityBasis: AuthorityInsufficient,
			Reason:         "The source does not carry sufficient mutation authority.",
		}
	}
	return response
}

func (b *Broker) addPending(run RunContext, action, capability string) (PendingConfirmation, error) {
	now := b.now()
	b.mu.Lock()
	defer b.mu.Unlock()
	b.pruneLocked(now)
	for _, existing := range b.pending {
		if existing.Source == sourceFamily(run.Source) && existing.ActorID == run.ActorID && existing.ConversationID == run.ConversationID && existing.ActionKey == action {
			return existing, nil
		}
	}
	id, err := b.randomToken(18)
	if err != nil {
		return PendingConfirmation{}, err
	}
	pending := PendingConfirmation{
		ID: id, Source: sourceFamily(run.Source), ActorID: run.ActorID, ConversationID: run.ConversationID,
		ActionKey: action, Capability: capability, ExpiresAt: now.Add(b.options.ConfirmationTTL),
	}
	b.pending[id] = pending
	return pending, nil
}

func (b *Broker) consume(runToken, approvalToken string, proposal Proposal) error {
	normalized, err := normalizeProposal(proposal)
	if err != nil {
		return err
	}
	now := b.now()
	b.mu.Lock()
	defer b.mu.Unlock()
	b.pruneLocked(now)
	run, ok := b.runs[runToken]
	if !ok {
		return ErrUnauthorized
	}
	approval, ok := b.approvals[approvalToken]
	if !ok || approval.runToken != runToken {
		return ErrUnauthorized
	}
	proposalHash := bindingHash(run.context, normalized)
	if proposalHash != approval.proposalHash {
		return ErrApprovalBinding
	}
	delete(b.approvals, approvalToken)
	run.ledger.prior = append(run.ledger.prior, PriorMutation{
		ProposalHash: proposalHash,
		Service:      normalized.Service,
		Method:       normalized.Method,
		Capability:   approval.classification.Capability,
		Risk:         approval.classification.Risk,
		AuthorizedAt: now,
		Execution:    ExecutionPending,
		proposalPath: normalized.Path,
	})
	return nil
}

func (b *Broker) recordAudit(ctx context.Context, record AuditRecord) error {
	if b.options.Audit == nil {
		return nil
	}
	return b.options.Audit.RecordMutationReview(ctx, record)
}

func (b *Broker) pruneLocked(now time.Time) {
	for token, run := range b.runs {
		if !now.Before(run.expiresAt) {
			delete(b.runs, token)
			for approvalToken, approval := range b.approvals {
				if approval.runToken == token {
					delete(b.approvals, approvalToken)
				}
			}
		}
	}
	for key, ledger := range b.ledgers {
		if !now.Before(ledger.expiresAt) {
			delete(b.ledgers, key)
		}
	}
	for token, approval := range b.approvals {
		if !now.Before(approval.expiresAt) {
			delete(b.approvals, token)
		}
	}
	for id, pending := range b.pending {
		if !now.Before(pending.ExpiresAt) {
			delete(b.pending, id)
		}
	}
	for key, grant := range b.grants {
		if !now.Before(grant.expiresAt) {
			delete(b.grants, key)
		}
	}
}

func (b *Broker) randomToken(size int) (string, error) {
	buffer := make([]byte, size)
	if _, err := io.ReadFull(b.options.Random, buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func (b *Broker) now() time.Time {
	return b.options.Now().UTC()
}

func confirmationKey(source, actorID, conversationID, action string) string {
	return sourceFamily(source) + "\x00" + actorID + "\x00" + conversationID + "\x00" + action
}

func sourceFamily(source string) string {
	source = strings.ToLower(strings.TrimSpace(source))
	for _, family := range []string{"discord", "seerr", "automation"} {
		if strings.HasPrefix(source, family) {
			return family
		}
	}
	return source
}

func runLedgerKey(run RunContext) string {
	return run.RunID + "\x00" + sourceFamily(run.Source) + "\x00" + run.ActorID + "\x00" + run.ConversationID
}
