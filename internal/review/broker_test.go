package review

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"testing"
	"time"
)

func TestBrokerHTTPApprovalBindingAndReplay(t *testing.T) {
	t.Parallel()

	broker := startTestBroker(t, reviewerResponse(VerdictApprove, AuthorityExplicitIntent), Options{})
	authorization := authorizeTestRun(t, broker, discordRun(3))
	proposal := mutationProposal("sonarr", "POST", "/api/v3/command", map[string]any{"name": "EpisodeSearch", "episodeIds": []int{7}})

	unauthorized := postBrokerJSON(t, broker.URL()+"/v1/reviews", "", proposal)
	if unauthorized.StatusCode != http.StatusUnauthorized {
		body, _ := io.ReadAll(unauthorized.Body)
		unauthorized.Body.Close()
		t.Fatalf("review without token status = %d body=%s, want 401", unauthorized.StatusCode, body)
	}
	unauthorized.Body.Close()

	reviewResponse := postBrokerJSON(t, broker.URL()+"/v1/reviews", authorization.Token, proposal)
	if reviewResponse.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(reviewResponse.Body)
		reviewResponse.Body.Close()
		t.Fatalf("review status = %d body=%s", reviewResponse.StatusCode, body)
	}
	var decision Decision
	decodeHTTPJSON(t, reviewResponse, &decision)
	if !decision.Approved() || decision.ApprovalToken == "" || decision.ProposalHash == "" {
		t.Fatalf("review decision = %+v, want bound approval", decision)
	}

	tampered := proposal
	tampered.Body = map[string]any{"name": "EpisodeSearch", "episodeIds": []int{8}}
	tamperedResponse := postBrokerJSON(t, broker.URL()+"/v1/approvals/consume", authorization.Token, map[string]any{
		"approval_token": decision.ApprovalToken,
		"proposal":       tampered,
	})
	if tamperedResponse.StatusCode != http.StatusConflict {
		body, _ := io.ReadAll(tamperedResponse.Body)
		tamperedResponse.Body.Close()
		t.Fatalf("tampered consume status = %d body=%s, want 409", tamperedResponse.StatusCode, body)
	}
	tamperedResponse.Body.Close()

	exactResponse := postBrokerJSON(t, broker.URL()+"/v1/approvals/consume", authorization.Token, map[string]any{
		"approval_token": decision.ApprovalToken,
		"proposal":       proposal,
	})
	if exactResponse.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(exactResponse.Body)
		exactResponse.Body.Close()
		t.Fatalf("exact consume status = %d body=%s, want 200", exactResponse.StatusCode, body)
	}
	var consumed struct {
		Authorized   bool   `json:"authorized"`
		ProposalHash string `json:"proposal_hash"`
	}
	decodeHTTPJSON(t, exactResponse, &consumed)
	if !consumed.Authorized || consumed.ProposalHash != decision.ProposalHash {
		t.Fatalf("consume response = %+v, want hash %s", consumed, decision.ProposalHash)
	}

	executionResponse := postBrokerJSON(t, broker.URL()+"/v1/mutations/execution", authorization.Token, map[string]any{
		"proposal_hash":      decision.ProposalHash,
		"status":             ExecutionSucceeded,
		"validation_targets": []string{"/api/v3/command/81"},
	})
	if executionResponse.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(executionResponse.Body)
		executionResponse.Body.Close()
		t.Fatalf("execution status = %d body=%s, want 200", executionResponse.StatusCode, body)
	}
	executionResponse.Body.Close()

	unrelatedObservation := postBrokerJSON(t, broker.URL()+"/v1/observations", authorization.Token, map[string]any{
		"proposal_hash": decision.ProposalHash,
		"service":       "sonarr",
		"path":          "/api/v3/queue",
		"outcome":       ValidationConfirmed,
	})
	if unrelatedObservation.StatusCode != http.StatusBadRequest {
		body, _ := io.ReadAll(unrelatedObservation.Body)
		unrelatedObservation.Body.Close()
		t.Fatalf("unrelated observation status = %d body=%s, want 400", unrelatedObservation.StatusCode, body)
	}
	unrelatedObservation.Body.Close()

	exactObservation := postBrokerJSON(t, broker.URL()+"/v1/observations", authorization.Token, map[string]any{
		"proposal_hash": decision.ProposalHash,
		"service":       "sonarr",
		"path":          "/api/v3/command/81",
		"outcome":       ValidationConfirmed,
	})
	if exactObservation.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(exactObservation.Body)
		exactObservation.Body.Close()
		t.Fatalf("exact observation status = %d body=%s, want 200", exactObservation.StatusCode, body)
	}
	exactObservation.Body.Close()

	replayResponse := postBrokerJSON(t, broker.URL()+"/v1/approvals/consume", authorization.Token, map[string]any{
		"approval_token": decision.ApprovalToken,
		"proposal":       proposal,
	})
	if replayResponse.StatusCode != http.StatusForbidden {
		body, _ := io.ReadAll(replayResponse.Body)
		replayResponse.Body.Close()
		t.Fatalf("replay consume status = %d body=%s, want 403", replayResponse.StatusCode, body)
	}
	replayResponse.Body.Close()
}

func TestBrokerReviewerOutcomesFailClosed(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		reviewer    Reviewer
		options     Options
		wantVerdict Verdict
		wantOutcome string
	}{
		{
			name:        "deny",
			reviewer:    reviewerResponse(VerdictDeny, AuthorityInsufficient),
			wantVerdict: VerdictDeny,
			wantOutcome: "reviewer_denied",
		},
		{
			name: "failure",
			reviewer: ReviewerFunc(func(context.Context, ReviewRequest) (ReviewResponse, error) {
				return ReviewResponse{}, errors.New("provider unavailable with private detail")
			}),
			wantVerdict: VerdictDeny,
			wantOutcome: "reviewer_failure",
		},
		{
			name: "timeout",
			reviewer: ReviewerFunc(func(ctx context.Context, _ ReviewRequest) (ReviewResponse, error) {
				<-ctx.Done()
				return ReviewResponse{}, ctx.Err()
			}),
			options:     Options{ReviewTimeout: 5 * time.Millisecond},
			wantVerdict: VerdictDeny,
			wantOutcome: "reviewer_failure",
		},
		{
			name: "invalid verdict",
			reviewer: ReviewerFunc(func(context.Context, ReviewRequest) (ReviewResponse, error) {
				return ReviewResponse{Verdict: "allow", AuthorityBasis: AuthorityExplicitIntent, Reason: "bad"}, nil
			}),
			wantVerdict: VerdictDeny,
			wantOutcome: "reviewer_failure",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			broker := startTestBroker(t, test.reviewer, test.options)
			authorization := authorizeTestRun(t, broker, discordRun(3))
			decision, err := broker.ReviewMutation(context.Background(), authorization.Token,
				mutationProposal("sonarr", "POST", "/api/v3/command", map[string]any{"name": "EpisodeSearch", "episodeIds": []int{7}}))
			if err != nil {
				t.Fatalf("ReviewMutation() error = %v", err)
			}
			if decision.Verdict != test.wantVerdict || decision.OutcomeCode != test.wantOutcome {
				t.Fatalf("ReviewMutation() = %+v, want verdict=%s outcome=%s", decision, test.wantVerdict, test.wantOutcome)
			}
		})
	}
}

func TestBrokerBudgetAndFreshReadGatePersistAcrossFollowup(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	var reviewCalls int
	reviewer := ReviewerFunc(func(context.Context, ReviewRequest) (ReviewResponse, error) {
		mu.Lock()
		reviewCalls++
		mu.Unlock()
		return ReviewResponse{Verdict: VerdictApprove, AuthorityBasis: AuthorityExplicitIntent, Reason: "explicit request"}, nil
	})
	broker := startTestBroker(t, reviewer, Options{})
	run := discordRun(2)
	authorization := authorizeTestRun(t, broker, run)
	first := mutationProposal("sonarr", "POST", "/api/v3/command", map[string]any{"name": "EpisodeSearch", "episodeIds": []int{7}})
	decision, err := broker.ReviewMutation(context.Background(), authorization.Token, first)
	if err != nil || !decision.Approved() {
		t.Fatalf("first ReviewMutation() = %+v, %v", decision, err)
	}
	firstHash := decision.ProposalHash

	second := mutationProposal("jellyfin", "POST", "/Items/abc/Refresh", nil)
	decision, err = broker.ReviewMutation(context.Background(), authorization.Token, second)
	if err != nil {
		t.Fatalf("unvalidated ReviewMutation() error = %v", err)
	}
	if decision.OutcomeCode != "validation_required" {
		t.Fatalf("unvalidated ReviewMutation() = %+v, want validation_required", decision)
	}
	mu.Lock()
	if reviewCalls != 1 {
		t.Fatalf("reviewer calls before validation = %d, want 1", reviewCalls)
	}
	mu.Unlock()

	if err := broker.RecordExecution(authorization.Token, firstHash, ExecutionSucceeded, []string{"/api/v3/queue"}); err == nil {
		t.Fatal("RecordExecution() accepted an unrelated validation target")
	}
	if err := broker.RecordExecution(authorization.Token, firstHash, ExecutionSucceeded, []string{"/api/v3/command/101"}); err != nil {
		t.Fatalf("RecordExecution() error = %v", err)
	}
	if err := broker.RecordValidation(authorization.Token, firstHash, "sonarr", "/api/v3/queue", ValidationConfirmed); err == nil {
		t.Fatal("RecordValidation() accepted an unrelated same-service GET")
	}
	if err := broker.RecordValidation(authorization.Token, firstHash, "sonarr", "/api/v3/command/101", ValidationConfirmed); err != nil {
		t.Fatalf("RecordValidation() error = %v", err)
	}
	decision, err = broker.ReviewMutation(context.Background(), authorization.Token, second)
	if err != nil || !decision.Approved() {
		t.Fatalf("validated second ReviewMutation() = %+v, %v", decision, err)
	}
	if err := broker.RecordExecution(authorization.Token, decision.ProposalHash, ExecutionSucceeded, []string{"/Items/abc"}); err != nil {
		t.Fatalf("RecordExecution(second) error = %v", err)
	}
	if err := broker.RecordValidation(authorization.Token, decision.ProposalHash, "jellyfin", "/Items/abc", ValidationConfirmed); err != nil {
		t.Fatalf("RecordValidation(second) error = %v", err)
	}

	broker.RevokeRun(authorization.Token)
	followup, err := broker.AuthorizeFollowup(run)
	if err != nil {
		t.Fatalf("AuthorizeFollowup() error = %v", err)
	}
	decision, err = broker.ReviewMutation(context.Background(), followup.Token, first)
	if err != nil {
		t.Fatalf("budget ReviewMutation() error = %v", err)
	}
	if decision.OutcomeCode != "budget_exhausted" {
		t.Fatalf("follow-up ReviewMutation() = %+v, want budget_exhausted", decision)
	}
}

func TestBrokerConcurrentReviewsDoNotBypassFreshReadGate(t *testing.T) {
	started := make(chan struct{}, 2)
	release := make(chan struct{})
	reviewer := ReviewerFunc(func(context.Context, ReviewRequest) (ReviewResponse, error) {
		started <- struct{}{}
		<-release
		return ReviewResponse{Verdict: VerdictApprove, AuthorityBasis: AuthorityExplicitIntent, Reason: "reviewed"}, nil
	})
	broker := startTestBroker(t, reviewer, Options{ReviewerCapacity: 2})
	authorization := authorizeTestRun(t, broker, discordRun(3))
	proposals := []Proposal{
		mutationProposal("sonarr", "POST", "/api/v3/command", map[string]any{"name": "EpisodeSearch", "episodeIds": []int{7}}),
		mutationProposal("jellyfin", "POST", "/Items/abc/Refresh", nil),
	}
	decisions := make(chan Decision, len(proposals))
	for _, proposal := range proposals {
		go func(proposal Proposal) {
			decision, err := broker.review(context.Background(), authorization.Token, proposal)
			if err != nil {
				t.Errorf("review() error = %v", err)
				return
			}
			decisions <- decision
		}(proposal)
	}
	<-started
	<-started
	close(release)

	var approved, blocked int
	for range proposals {
		decision := <-decisions
		if decision.Approved() {
			approved++
			continue
		}
		if decision.OutcomeCode == "validation_required" {
			blocked++
		}
	}
	if approved != 1 || blocked != 1 {
		t.Fatalf("concurrent reviews approved=%d validation_required=%d, want 1 each", approved, blocked)
	}
}

func TestBrokerExecutionFailureIsTrackedWithoutFalseValidation(t *testing.T) {
	t.Parallel()

	broker := startTestBroker(t, reviewerResponse(VerdictApprove, AuthorityExplicitIntent), Options{})
	authorization := authorizeTestRun(t, broker, discordRun(3))
	first := mutationProposal("sonarr", "POST", "/api/v3/command", map[string]any{"name": "EpisodeSearch", "episodeIds": []int{7}})
	decision, err := broker.ReviewMutation(context.Background(), authorization.Token, first)
	if err != nil || !decision.Approved() {
		t.Fatalf("ReviewMutation() = %+v, %v", decision, err)
	}
	if err := broker.RecordExecution(authorization.Token, decision.ProposalHash, ExecutionFailed, nil); err != nil {
		t.Fatalf("RecordExecution(failed) error = %v", err)
	}
	if err := broker.RecordValidation(authorization.Token, decision.ProposalHash, "sonarr", "/api/v3/command/101", ValidationConfirmed); err == nil {
		t.Fatal("RecordValidation() accepted a failed mutation")
	}

	second := mutationProposal("jellyfin", "POST", "/Items/abc/Refresh", nil)
	decision, err = broker.ReviewMutation(context.Background(), authorization.Token, second)
	if err != nil || !decision.Approved() {
		t.Fatalf("ReviewMutation() after known failed execution = %+v, %v", decision, err)
	}
}

func TestBrokerUnknownExecutionBlocksFurtherMutation(t *testing.T) {
	t.Parallel()

	broker := startTestBroker(t, reviewerResponse(VerdictApprove, AuthorityExplicitIntent), Options{})
	authorization := authorizeTestRun(t, broker, discordRun(3))
	first := mutationProposal("sonarr", "POST", "/api/v3/command", map[string]any{"name": "EpisodeSearch", "episodeIds": []int{7}})
	decision, err := broker.ReviewMutation(context.Background(), authorization.Token, first)
	if err != nil || !decision.Approved() {
		t.Fatalf("ReviewMutation() = %+v, %v", decision, err)
	}
	if err := broker.RecordExecution(authorization.Token, decision.ProposalHash, ExecutionUnknown, nil); err != nil {
		t.Fatalf("RecordExecution(unknown) error = %v", err)
	}

	second := mutationProposal("jellyfin", "POST", "/Items/abc/Refresh", nil)
	decision, err = broker.ReviewMutation(context.Background(), authorization.Token, second)
	if err != nil {
		t.Fatalf("ReviewMutation() error = %v", err)
	}
	if decision.OutcomeCode != "validation_required" {
		t.Fatalf("ReviewMutation() = %+v, want validation_required", decision)
	}
}

func TestBrokerExecutionAndValidationAuditFailuresDoNotAdvanceLedger(t *testing.T) {
	t.Parallel()

	audit := &recordingAudit{executionErr: errors.New("execution audit unavailable")}
	broker := startTestBroker(t, reviewerResponse(VerdictApprove, AuthorityExplicitIntent), Options{Audit: audit})
	authorization := authorizeTestRun(t, broker, discordRun(2))
	first := mutationProposal("sonarr", "POST", "/api/v3/command", map[string]any{"name": "EpisodeSearch", "episodeIds": []int{7}})
	decision, err := broker.ReviewMutation(context.Background(), authorization.Token, first)
	if err != nil || !decision.Approved() {
		t.Fatalf("ReviewMutation() = %+v, %v", decision, err)
	}
	if err := broker.RecordExecution(authorization.Token, decision.ProposalHash, ExecutionSucceeded, []string{"/api/v3/command/101"}); err == nil {
		t.Fatal("RecordExecution() succeeded despite audit failure")
	}
	audit.executionErr = nil
	if err := broker.RecordExecution(authorization.Token, decision.ProposalHash, ExecutionSucceeded, []string{"/api/v3/command/101"}); err != nil {
		t.Fatalf("RecordExecution() retry error = %v", err)
	}

	audit.validationErr = errors.New("validation audit unavailable")
	if err := broker.RecordValidation(authorization.Token, decision.ProposalHash, "sonarr", "/api/v3/command/101", ValidationConfirmed); err == nil {
		t.Fatal("RecordValidation() succeeded despite audit failure")
	}
	second := mutationProposal("jellyfin", "POST", "/Items/abc/Refresh", nil)
	blocked, err := broker.ReviewMutation(context.Background(), authorization.Token, second)
	if err != nil {
		t.Fatalf("ReviewMutation() after failed validation audit error = %v", err)
	}
	if blocked.OutcomeCode != "validation_required" {
		t.Fatalf("ReviewMutation() after failed validation audit = %+v, want validation_required", blocked)
	}
	audit.validationErr = nil
	if err := broker.RecordValidation(authorization.Token, decision.ProposalHash, "sonarr", "/api/v3/command/101", ValidationConfirmed); err != nil {
		t.Fatalf("RecordValidation() retry error = %v", err)
	}
	approved, err := broker.ReviewMutation(context.Background(), authorization.Token, second)
	if err != nil || !approved.Approved() {
		t.Fatalf("ReviewMutation() after validation retry = %+v, %v", approved, err)
	}
}

func TestValidationTargetsAreBoundToMutationTarget(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		prior  PriorMutation
		target string
		wrong  string
	}{
		{name: "arr command result", prior: PriorMutation{Capability: "sonarr.search", proposalPath: "/api/v3/command"}, target: "/api/v3/command/91", wrong: "/api/v3/queue"},
		{name: "queue deletion", prior: PriorMutation{Capability: "radarr.queue_cleanup", proposalPath: "/api/v3/queue/17?removeFromClient=true"}, target: "/api/v3/queue/17", wrong: "/api/v3/queue/18"},
		{name: "queue grab", prior: PriorMutation{Capability: "sonarr.queue_grab", proposalPath: "/api/v3/queue/grab/23"}, target: "/api/v3/queue/23", wrong: "/api/v3/queue/24"},
		{name: "jellyfin item", prior: PriorMutation{Capability: "jellyfin.metadata_refresh", proposalPath: "/Items/abc/Refresh?Recursive=true"}, target: "/Items/abc", wrong: "/Items/def"},
		{name: "seerr issue", prior: PriorMutation{Capability: "seerr.issue_resolve", proposalPath: "/api/v1/issue/42/resolved"}, target: "/api/v1/issue/42", wrong: "/api/v1/issue/43"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if !validationTargetsAllowed(test.prior, []string{test.target}) {
				t.Fatalf("validationTargetsAllowed(%q) = false", test.target)
			}
			if validationTargetsAllowed(test.prior, []string{test.wrong}) {
				t.Fatalf("validationTargetsAllowed(%q) = true", test.wrong)
			}
		})
	}
}

func TestBrokerRequiresCurrentSameServiceReadEvidence(t *testing.T) {
	t.Parallel()

	var calls int
	broker := startTestBroker(t, ReviewerFunc(func(context.Context, ReviewRequest) (ReviewResponse, error) {
		calls++
		return ReviewResponse{Verdict: VerdictApprove, AuthorityBasis: AuthorityExplicitIntent, Reason: "approved"}, nil
	}), Options{})
	authorization := authorizeTestRun(t, broker, discordRun(3))
	proposal := mutationProposal("sonarr", "POST", "/api/v3/command", map[string]any{"name": "EpisodeSearch", "episodeIds": []int{7}})
	proposal.Evidence = []Evidence{{Service: "radarr", Method: "GET", Path: "/api/v3/queue", Summary: `{"records":[]}`}}
	decision, err := broker.ReviewMutation(context.Background(), authorization.Token, proposal)
	if err != nil {
		t.Fatalf("ReviewMutation() error = %v", err)
	}
	if decision.OutcomeCode != "evidence_required" || calls != 0 {
		t.Fatalf("ReviewMutation() = %+v reviewer_calls=%d, want evidence_required before reviewer", decision, calls)
	}
}

func TestBrokerAutomationCapabilitiesAndConfirmationAreMechanical(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	var calls int
	reviewer := ReviewerFunc(func(context.Context, ReviewRequest) (ReviewResponse, error) {
		mu.Lock()
		calls++
		mu.Unlock()
		return ReviewResponse{Verdict: VerdictNeedsConfirmation, AuthorityBasis: AuthorityInsufficient, Reason: "manual review"}, nil
	})
	broker := startTestBroker(t, reviewer, Options{})
	run := RunContext{
		RunID: "automation-run", Source: "automation_cron", ActorID: "scheduler", ConversationID: "automation:stale",
		Authority: "checked-in automations/hourly-stale-import-handler.md", MutationPolicy: "narrow", Budget: 5,
		Capabilities: []string{"sonarr.manual_import"},
	}
	authorization := authorizeTestRun(t, broker, run)
	manualImport := mutationProposal("sonarr", "POST", "/api/v3/command", map[string]any{"name": "ManualImport", "files": []any{map[string]any{"path": "/file"}}})
	decision, err := broker.ReviewMutation(context.Background(), authorization.Token, manualImport)
	if err != nil {
		t.Fatalf("ReviewMutation(manual import) error = %v", err)
	}
	if decision.Verdict != VerdictDeny || decision.OutcomeCode != "manual_review_required" || decision.Confirmation != nil {
		t.Fatalf("automation needs_confirmation = %+v, want deny/manual_review_required", decision)
	}
	if pending := broker.PendingFor("scheduler", "automation:stale"); len(pending) != 0 {
		t.Fatalf("automation registered interactive confirmations: %+v", pending)
	}

	queueDelete := mutationProposal("sonarr", "DELETE", "/api/v3/queue/7?removeFromClient=true&blocklist=true", nil)
	decision, err = broker.ReviewMutation(context.Background(), authorization.Token, queueDelete)
	if err != nil {
		t.Fatalf("ReviewMutation(queue delete) error = %v", err)
	}
	if decision.OutcomeCode != "capability_denied" {
		t.Fatalf("out-of-capability decision = %+v, want capability_denied", decision)
	}
	mu.Lock()
	if calls != 1 {
		t.Fatalf("reviewer calls = %d, want 1 (policy denial must precede reviewer)", calls)
	}
	mu.Unlock()
}

func TestBrokerAutomationApprovalRequiresTrustedAuthorityBasis(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name        string
		basis       AuthorityBasis
		wantApprove bool
	}{
		{name: "explicit user intent is not automation authority", basis: AuthorityExplicitIntent},
		{name: "trusted automation authority", basis: AuthorityTrustedAutomation, wantApprove: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			broker := startTestBroker(t, reviewerResponse(VerdictApprove, test.basis), Options{})
			run := RunContext{
				RunID: "automation-run", Source: "automation_cron", ActorID: "scheduler", ConversationID: "automation:stale",
				Authority: "checked-in task definition", MutationPolicy: "narrow", Budget: 5,
				Capabilities: []string{"radarr.manual_import"},
			}
			authorization := authorizeTestRun(t, broker, run)
			proposal := mutationProposal("radarr", "POST", "/api/v3/command", map[string]any{"name": "ManualImport", "files": []any{map[string]any{"path": "/file"}}})
			decision, err := broker.ReviewMutation(context.Background(), authorization.Token, proposal)
			if err != nil {
				t.Fatalf("ReviewMutation() error = %v", err)
			}
			if decision.Approved() != test.wantApprove {
				t.Fatalf("ReviewMutation() = %+v, want approve=%v", decision, test.wantApprove)
			}
		})
	}
}

func TestBrokerDiscordConfirmationBindsActorConversationAndFreshAction(t *testing.T) {
	t.Parallel()

	reviewer := ReviewerFunc(func(_ context.Context, request ReviewRequest) (ReviewResponse, error) {
		if request.Confirmation == nil {
			return ReviewResponse{Verdict: VerdictNeedsConfirmation, AuthorityBasis: AuthorityInsufficient, Reason: "ask owner"}, nil
		}
		return ReviewResponse{Verdict: VerdictApprove, AuthorityBasis: AuthorityConfirmedIntent, Reason: "matching confirmation"}, nil
	})
	broker := startTestBroker(t, reviewer, Options{})
	run := discordRun(3)
	authorization := authorizeTestRun(t, broker, run)
	original := mutationProposal("sonarr", "DELETE", "/api/v3/queue/7?removeFromClient=true&blocklist=true", nil)
	decision, err := broker.ReviewMutation(context.Background(), authorization.Token, original)
	if err != nil || decision.Verdict != VerdictNeedsConfirmation || decision.Confirmation == nil {
		t.Fatalf("first ReviewMutation() = %+v, %v", decision, err)
	}
	if err := broker.ConfirmLatest("other-user", run.ConversationID); err == nil {
		t.Fatal("ConfirmLatest() accepted a different actor")
	}
	if err := broker.ConfirmLatest(run.ActorID, run.ConversationID); err != nil {
		t.Fatalf("ConfirmLatest() error = %v", err)
	}

	broker.RevokeRun(authorization.Token)
	followup := authorizeTestRun(t, broker, run)
	different := mutationProposal("sonarr", "DELETE", "/api/v3/queue/8?removeFromClient=true&blocklist=true", nil)
	decision, err = broker.ReviewMutation(context.Background(), followup.Token, different)
	if err != nil || decision.Verdict != VerdictNeedsConfirmation {
		t.Fatalf("different action ReviewMutation() = %+v, %v, want needs_confirmation", decision, err)
	}

	decision, err = broker.ReviewMutation(context.Background(), followup.Token, original)
	if err != nil || !decision.Approved() {
		t.Fatalf("confirmed fresh ReviewMutation() = %+v, %v", decision, err)
	}
}

func TestBrokerConfirmationExpires(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
	broker := startTestBroker(t, reviewerResponse(VerdictNeedsConfirmation, AuthorityInsufficient), Options{
		ConfirmationTTL: time.Minute,
		Now:             func() time.Time { return now },
	})
	run := discordRun(3)
	authorization := authorizeTestRun(t, broker, run)
	proposal := mutationProposal("sonarr", "DELETE", "/api/v3/queue/7", nil)
	decision, err := broker.ReviewMutation(context.Background(), authorization.Token, proposal)
	if err != nil || decision.Confirmation == nil {
		t.Fatalf("ReviewMutation() = %+v, %v", decision, err)
	}
	now = now.Add(2 * time.Minute)
	if err := broker.ConfirmLatest(run.ActorID, run.ConversationID); err == nil {
		t.Fatal("ConfirmLatest() accepted an expired confirmation")
	}
}

func TestBrokerAuditFailureDeniesApproval(t *testing.T) {
	t.Parallel()

	audit := &recordingAudit{err: errors.New("database unavailable")}
	broker := startTestBroker(t, reviewerResponse(VerdictApprove, AuthorityExplicitIntent), Options{Audit: audit})
	authorization := authorizeTestRun(t, broker, discordRun(3))
	decision, err := broker.ReviewMutation(context.Background(), authorization.Token,
		mutationProposal("sonarr", "POST", "/api/v3/command", map[string]any{"name": "EpisodeSearch", "episodeIds": []int{7}}))
	if err != nil {
		t.Fatalf("ReviewMutation() error = %v", err)
	}
	if decision.Verdict != VerdictDeny || decision.OutcomeCode != "audit_failure" || decision.ApprovalToken != "" {
		t.Fatalf("ReviewMutation() = %+v, want fail-closed audit denial", decision)
	}
	if len(audit.records) != 1 || audit.records[0].ProposalHash == "" || audit.records[0].ActorID != "user-1" {
		t.Fatalf("audit records = %+v", audit.records)
	}
	if audit.records[0].Error != "" {
		t.Fatalf("audit record leaked error detail: %+v", audit.records[0])
	}
}

type recordingAudit struct {
	mu            sync.Mutex
	records       []AuditRecord
	err           error
	executionErr  error
	validationErr error
}

func (a *recordingAudit) RecordMutationExecution(_ context.Context, _ ExecutionAuditRecord) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.executionErr
}

func (a *recordingAudit) RecordMutationValidation(_ context.Context, _ ValidationAuditRecord) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.validationErr
}

func (a *recordingAudit) RecordMutationReview(_ context.Context, record AuditRecord) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.records = append(a.records, record)
	return a.err
}

func reviewerResponse(verdict Verdict, basis AuthorityBasis) Reviewer {
	return ReviewerFunc(func(context.Context, ReviewRequest) (ReviewResponse, error) {
		return ReviewResponse{Verdict: verdict, AuthorityBasis: basis, Reason: "reviewed"}, nil
	})
}

func startTestBroker(t *testing.T, reviewer Reviewer, options Options) *Broker {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	broker := NewBroker(reviewer, options)
	if err := broker.Start(ctx); err != nil {
		cancel()
		t.Fatalf("Start() error = %v", err)
	}
	t.Cleanup(func() {
		cancel()
		_ = broker.Close()
	})
	return broker
}

func authorizeTestRun(t *testing.T, broker *Broker, run RunContext) Authorization {
	t.Helper()
	authorization, err := broker.AuthorizeRun(run)
	if err != nil {
		t.Fatalf("AuthorizeRun() error = %v", err)
	}
	return authorization
}

func discordRun(budget int) RunContext {
	return RunContext{
		RunID: "run-1", Source: "discord_private", ActorID: "user-1", ConversationID: "thread-1",
		Authority: "the thread owner explicitly requested this exact action", MutationPolicy: "reviewed", Budget: budget,
	}
}

func postBrokerJSON(t *testing.T, url, token string, value any) *http.Response {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	request, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("http.NewRequest() error = %v", err)
	}
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("http.Do() error = %v", err)
	}
	return response
}

func decodeHTTPJSON(t *testing.T, response *http.Response, target any) {
	t.Helper()
	defer response.Body.Close()
	if err := json.NewDecoder(response.Body).Decode(target); err != nil {
		t.Fatalf("decode response JSON: %v", err)
	}
}
