package harness

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"sync"

	"blitzcrank/internal/review"
)

type issueResolutionBroker interface {
	AuthorizeFollowup(review.RunContext) (review.Authorization, error)
	ReviewMutation(context.Context, string, review.Proposal) (review.Decision, error)
	RecordExecution(string, string, string, []string) error
	RecordValidation(string, string, string, string, string) error
	Confirm(string, string, string) error
	RevokeRun(string)
}

// BrokerIssueResolutionReviewer applies the same deterministic policy,
// independent review, exact binding, shared run budget, and audit path used by
// Pi service-tool mutations to the Go-owned Seerr resolution mutation.
type BrokerIssueResolutionReviewer struct {
	broker issueResolutionBroker
	budget int
	mu     sync.Mutex
	active map[string]resolutionAuthorization
}

type resolutionAuthorization struct {
	token        string
	path         string
	proposalHash string
}

func NewBrokerIssueResolutionReviewer(broker issueResolutionBroker, budget int) *BrokerIssueResolutionReviewer {
	return &BrokerIssueResolutionReviewer{
		broker: broker,
		budget: budget,
		active: make(map[string]resolutionAuthorization),
	}
}

func (r *BrokerIssueResolutionReviewer) ReviewIssueResolution(ctx context.Context, request IssueResolutionReview) (IssueResolutionDecision, error) {
	if r == nil || r.broker == nil {
		return IssueResolutionDecision{Verdict: string(review.VerdictDeny), Reason: "resolution review broker is unavailable"}, nil
	}
	if strings.TrimSpace(request.CurrentState) == "" {
		return IssueResolutionDecision{Verdict: string(review.VerdictDeny), Reason: "fresh Seerr issue state is missing"}, nil
	}
	authorization, err := r.broker.AuthorizeFollowup(review.RunContext{
		RunID:          request.RunID,
		Source:         request.Source,
		ActorID:        request.ActorID,
		ConversationID: request.ConversationID,
		Authority:      request.Authority,
		MutationPolicy: request.MutationPolicy,
		Budget:         r.budget,
	})
	if err != nil {
		return IssueResolutionDecision{}, fmt.Errorf("authorize Seerr resolution review: %w", err)
	}
	issuePath := "/api/v1/issue/" + url.PathEscape(strings.TrimSpace(request.IssueID))
	path := issuePath + "/resolved"
	decision, err := r.broker.ReviewMutation(ctx, authorization.Token, review.Proposal{
		Service:     "seerr",
		Method:      "POST",
		Path:        path,
		Body:        nil,
		Purpose:     "Close the exact Seerr issue after the working agent returned its final validated outcome.",
		SafetyClaim: "The working agent proposed RESOLVE_ISSUE after its investigation; independently verify that its response and requester authority justify closure.",
		Evidence: []review.Evidence{
			{
				Service: "seerr",
				Method:  "GET",
				Path:    issuePath,
				Summary: "Fresh current Seerr issue state: " + strings.TrimSpace(request.CurrentState),
			},
			{
				Service: "seerr",
				Summary: "Untrusted proposed public outcome and working-agent validation claim: " + strings.TrimSpace(request.FinalComment) + "\n" + strings.TrimSpace(request.AgentResponse),
			},
		},
	})
	if err != nil {
		r.broker.RevokeRun(authorization.Token)
		return IssueResolutionDecision{}, fmt.Errorf("review Seerr resolution: %w", err)
	}
	result := IssueResolutionDecision{
		Verdict: string(decision.Verdict),
		Reason:  decision.Reason,
	}
	if decision.Confirmation != nil {
		result.ConfirmationID = decision.Confirmation.ID
	}
	if !decision.Approved() {
		r.broker.RevokeRun(authorization.Token)
		return result, nil
	}
	r.mu.Lock()
	if previous, ok := r.active[request.RunID]; ok {
		r.broker.RevokeRun(previous.token)
	}
	r.active[request.RunID] = resolutionAuthorization{token: authorization.Token, path: issuePath, proposalHash: decision.ProposalHash}
	r.mu.Unlock()
	return result, nil
}

func (r *BrokerIssueResolutionReviewer) ConfirmIssueResolution(_ context.Context, confirmationID, actorID, conversationID string) error {
	if r == nil || r.broker == nil {
		return fmt.Errorf("resolution review broker is unavailable")
	}
	return r.broker.Confirm(confirmationID, actorID, conversationID)
}

func (r *BrokerIssueResolutionReviewer) CompleteIssueResolution(_ context.Context, runID string, validated bool) {
	if r == nil || r.broker == nil {
		return
	}
	r.mu.Lock()
	authorization, ok := r.active[runID]
	if ok {
		delete(r.active, runID)
	}
	r.mu.Unlock()
	if !ok {
		return
	}
	if validated {
		if err := r.broker.RecordExecution(authorization.token, authorization.proposalHash, review.ExecutionSucceeded, []string{authorization.path}); err == nil {
			_ = r.broker.RecordValidation(authorization.token, authorization.proposalHash, "seerr", authorization.path, review.ValidationConfirmed)
		}
	} else {
		_ = r.broker.RecordExecution(authorization.token, authorization.proposalHash, review.ExecutionUnknown, nil)
	}
	r.broker.RevokeRun(authorization.token)
}
