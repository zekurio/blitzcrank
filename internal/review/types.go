package review

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
)

const (
	EnvBrokerURL = "BLITZCRANK_REVIEW_BROKER_URL"
	EnvRunToken  = "BLITZCRANK_REVIEW_TOKEN"
)

type Risk string

const (
	RiskLow    Risk = "low"
	RiskMedium Risk = "medium"
	RiskHigh   Risk = "high"
)

type Verdict string

const (
	VerdictApprove           Verdict = "approve"
	VerdictDeny              Verdict = "deny"
	VerdictNeedsConfirmation Verdict = "needs_confirmation"
)

type AuthorityBasis string

const (
	AuthorityPassiveCorrection AuthorityBasis = "passive_correction"
	AuthorityExplicitIntent    AuthorityBasis = "explicit_intent"
	AuthorityConfirmedIntent   AuthorityBasis = "confirmed_intent"
	AuthorityTrustedAutomation AuthorityBasis = "trusted_automation"
	AuthorityInsufficient      AuthorityBasis = "insufficient"
)

type RunContext struct {
	RunID          string   `json:"run_id"`
	Source         string   `json:"source"`
	ActorID        string   `json:"actor_id"`
	ConversationID string   `json:"conversation_id"`
	Authority      string   `json:"authority"`
	Capabilities   []string `json:"capabilities,omitempty"`
	MutationPolicy string   `json:"mutation_policy,omitempty"`
	Budget         int      `json:"budget"`
}

type Evidence struct {
	Service string `json:"service,omitempty"`
	Method  string `json:"method,omitempty"`
	Path    string `json:"path,omitempty"`
	Summary string `json:"summary"`
}

type Proposal struct {
	Service     string     `json:"service"`
	Method      string     `json:"method"`
	Path        string     `json:"path"`
	Body        any        `json:"body,omitempty"`
	Purpose     string     `json:"purpose"`
	SafetyClaim string     `json:"safety_claim"`
	Evidence    []Evidence `json:"evidence,omitempty"`
}

type SanitizedProposal struct {
	Service     string          `json:"service"`
	Method      string          `json:"method"`
	Path        string          `json:"path"`
	Body        json.RawMessage `json:"body"`
	Purpose     string          `json:"purpose"`
	SafetyClaim string          `json:"safety_claim"`
	Evidence    []Evidence      `json:"evidence,omitempty"`
}

type Classification struct {
	Risk       Risk   `json:"risk"`
	Capability string `json:"capability"`
	Category   string `json:"category"`
}

type PriorMutation struct {
	ProposalHash      string    `json:"proposal_hash"`
	Service           string    `json:"service"`
	Method            string    `json:"method"`
	Capability        string    `json:"capability"`
	Risk              Risk      `json:"risk"`
	AuthorizedAt      time.Time `json:"authorized_at"`
	ExecutedAt        time.Time `json:"executed_at,omitempty"`
	Execution         string    `json:"execution,omitempty"`
	ValidationTargets []string  `json:"validation_targets,omitempty"`
	ObservedAt        time.Time `json:"observed_at,omitempty"`
	ValidatedAt       time.Time `json:"validated_at,omitempty"`
	proposalPath      string
}

const (
	ExecutionPending   = "pending"
	ExecutionSucceeded = "succeeded"
	ExecutionFailed    = "failed"
	ExecutionUnknown   = "unknown"

	ValidationConfirmed    = "confirmed"
	ValidationNotConfirmed = "not_confirmed"
)

type ConfirmationContext struct {
	ConfirmedAt time.Time `json:"confirmed_at"`
	ActionKey   string    `json:"action_key"`
}

type ReviewRequest struct {
	Context      RunContext           `json:"trusted_context"`
	Proposal     SanitizedProposal    `json:"proposal"`
	ProposalHash string               `json:"proposal_hash"`
	Baseline     Classification       `json:"deterministic_baseline"`
	Prior        []PriorMutation      `json:"prior_mutations,omitempty"`
	Confirmation *ConfirmationContext `json:"confirmation,omitempty"`
}

type ReviewResponse struct {
	Verdict        Verdict        `json:"verdict"`
	AuthorityBasis AuthorityBasis `json:"authority_basis"`
	Reason         string         `json:"reason"`
}

type Reviewer interface {
	Review(context.Context, ReviewRequest) (ReviewResponse, error)
}

type ReviewerFunc func(context.Context, ReviewRequest) (ReviewResponse, error)

func (f ReviewerFunc) Review(ctx context.Context, req ReviewRequest) (ReviewResponse, error) {
	return f(ctx, req)
}

type PendingConfirmation struct {
	ID             string    `json:"id"`
	Source         string    `json:"source"`
	ActorID        string    `json:"actor_id"`
	ConversationID string    `json:"conversation_id"`
	ActionKey      string    `json:"action_key"`
	Capability     string    `json:"capability"`
	ExpiresAt      time.Time `json:"expires_at"`
}

type Decision struct {
	Verdict       Verdict              `json:"verdict"`
	Reason        string               `json:"reason"`
	OutcomeCode   string               `json:"outcome_code"`
	Risk          Risk                 `json:"risk,omitempty"`
	Capability    string               `json:"capability,omitempty"`
	ProposalHash  string               `json:"proposal_hash,omitempty"`
	ApprovalToken string               `json:"approval_token,omitempty"`
	Confirmation  *PendingConfirmation `json:"confirmation,omitempty"`
}

func (d Decision) Approved() bool {
	return d.Verdict == VerdictApprove
}

type AuditRecord struct {
	ProposalHash   string
	RunID          string
	Source         string
	ActorID        string
	ConversationID string
	Service        string
	Method         string
	Capability     string
	OutcomeCode    string
	Risk           Risk
	Verdict        Verdict
	MutationIndex  int
	Confirmed      bool
	ReviewedAt     time.Time
	Duration       time.Duration
	Error          string
}

type AuditSink interface {
	RecordMutationReview(context.Context, AuditRecord) error
}

type ExecutionAuditRecord struct {
	ProposalHash string
	RunID        string
	Status       string
	ExecutedAt   time.Time
}

type ValidationAuditRecord struct {
	ProposalHash string
	RunID        string
	Service      string
	Outcome      string
	ObservedAt   time.Time
}

type ExecutionAuditSink interface {
	RecordMutationExecution(context.Context, ExecutionAuditRecord) error
}

type ValidationAuditSink interface {
	RecordMutationValidation(context.Context, ValidationAuditRecord) error
}

type Authorization struct {
	BrokerURL string
	Token     string
	ExpiresAt time.Time
}

func (a Authorization) Env() []string {
	return []string{EnvBrokerURL + "=" + a.BrokerURL, EnvRunToken + "=" + a.Token}
}

func ParseReviewerResponse(data []byte) (ReviewResponse, error) {
	if len(data) == 0 {
		return ReviewResponse{}, fmt.Errorf("reviewer response is empty")
	}
	if len(data) > 64*1024 {
		return ReviewResponse{}, fmt.Errorf("reviewer response exceeds 64 KiB")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var response ReviewResponse
	if err := decoder.Decode(&response); err != nil {
		return ReviewResponse{}, fmt.Errorf("decode reviewer response: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return ReviewResponse{}, fmt.Errorf("reviewer response contains multiple JSON values")
		}
		return ReviewResponse{}, fmt.Errorf("decode reviewer response trailer: %w", err)
	}
	response.Reason = strings.TrimSpace(response.Reason)
	switch response.Verdict {
	case VerdictApprove, VerdictDeny, VerdictNeedsConfirmation:
	default:
		return ReviewResponse{}, fmt.Errorf("invalid reviewer verdict %q", response.Verdict)
	}
	if response.Reason == "" {
		return ReviewResponse{}, fmt.Errorf("reviewer reason is required")
	}
	switch response.AuthorityBasis {
	case AuthorityPassiveCorrection, AuthorityExplicitIntent, AuthorityConfirmedIntent,
		AuthorityTrustedAutomation, AuthorityInsufficient:
	default:
		return ReviewResponse{}, fmt.Errorf("invalid reviewer authority_basis %q", response.AuthorityBasis)
	}
	return response, nil
}
