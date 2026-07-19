package harness

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"blitzcrank/internal/review"
)

func TestBrokerIssueResolutionReviewerUsesSharedRunAndValidatesObservation(t *testing.T) {
	broker := &fakeResolutionBroker{
		authorization: review.Authorization{Token: "run-token", BrokerURL: "http://127.0.0.1:1"},
		decision:      review.Decision{Verdict: review.VerdictApprove, Reason: "authorized", ProposalHash: "hash"},
	}
	reviewer := NewBrokerIssueResolutionReviewer(broker, 5)
	request := IssueResolutionReview{
		RunID:          "run-1",
		Source:         "seerr_issue_comment",
		ConversationID: "issue:42",
		ActorID:        "user-7",
		Authority:      "Bitte beheben und schließen",
		IssueID:        "42",
		FinalComment:   "Behoben und validiert.",
		CurrentState:   `{"status":1}`,
		MutationPolicy: "issue_report_and_reporter_comments",
	}

	decision, err := reviewer.ReviewIssueResolution(context.Background(), request)
	if err != nil {
		t.Fatalf("ReviewIssueResolution() error = %v", err)
	}
	if decision.Verdict != "approve" {
		t.Fatalf("ReviewIssueResolution() = %+v", decision)
	}
	if broker.run.RunID != request.RunID || broker.run.Budget != 5 || broker.run.ActorID != request.ActorID {
		t.Fatalf("follow-up context = %+v", broker.run)
	}
	if broker.proposal.Service != "seerr" || broker.proposal.Method != "POST" || broker.proposal.Path != "/api/v1/issue/42/resolved" {
		t.Fatalf("proposal = %+v", broker.proposal)
	}

	reviewer.CompleteIssueResolution(context.Background(), request.RunID, true)
	if len(broker.observations) != 2 || broker.observations[0] != "run-token:hash:succeeded" || broker.observations[1] != "run-token:hash:seerr:/api/v1/issue/42:confirmed" {
		t.Fatalf("observations = %#v", broker.observations)
	}
	if len(broker.revoked) != 1 || broker.revoked[0] != "run-token" {
		t.Fatalf("revoked = %#v", broker.revoked)
	}
}

func TestBrokerIssueResolutionReviewerMapsBoundConfirmation(t *testing.T) {
	broker := &fakeResolutionBroker{
		authorization: review.Authorization{Token: "run-token"},
		decision: review.Decision{
			Verdict: review.VerdictNeedsConfirmation,
			Reason:  "confirm closure",
			Confirmation: &review.PendingConfirmation{
				ID: "confirmation-1",
			},
		},
	}
	reviewer := NewBrokerIssueResolutionReviewer(broker, 5)
	decision, err := reviewer.ReviewIssueResolution(context.Background(), IssueResolutionReview{
		RunID: "run-1", Source: "seerr_issue_reported", ConversationID: "issue:42",
		ActorID: "user-7", Authority: "Es geht wieder", IssueID: "42", FinalComment: "Behoben.", CurrentState: `{"status":1}`, MutationPolicy: "issue_report_and_reporter_comments",
	})
	if err != nil {
		t.Fatalf("ReviewIssueResolution() error = %v", err)
	}
	if decision.Verdict != "needs_confirmation" || decision.ConfirmationID != "confirmation-1" {
		t.Fatalf("decision = %+v", decision)
	}
	if len(broker.revoked) != 1 {
		t.Fatalf("revoked = %#v, want denied follow-up revoked", broker.revoked)
	}
	if err := reviewer.ConfirmIssueResolution(context.Background(), decision.ConfirmationID, "user-7", "issue:42"); err != nil {
		t.Fatalf("ConfirmIssueResolution() error = %v", err)
	}
	if len(broker.confirmed) != 1 || broker.confirmed[0] != "confirmation-1:user-7:issue:42" {
		t.Fatalf("confirmed = %#v", broker.confirmed)
	}
}

func TestSeerrIssueResolvedRequiresFreshResolvedStatus(t *testing.T) {
	tests := []struct {
		name  string
		value any
		want  bool
	}{
		{name: "numeric resolved", value: map[string]any{"status": float64(2)}, want: true},
		{name: "string resolved", value: map[string]any{"status": "RESOLVED"}, want: true},
		{name: "open", value: map[string]any{"status": float64(1)}},
		{name: "missing", value: map[string]any{"ok": true}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := seerrIssueResolved(test.value); got != test.want {
				t.Fatalf("seerrIssueResolved(%#v) = %t, want %t", test.value, got, test.want)
			}
		})
	}
}

func TestExplicitIssueConfirmationIsConservative(t *testing.T) {
	for _, value := range []string{"ja", "Ja, bitte!", "yes please", "mach das"} {
		if !isExplicitIssueConfirmation(value) {
			t.Errorf("isExplicitIssueConfirmation(%q) = false", value)
		}
	}
	for _, value := range []string{"ja, aber nimm die andere Folge", "vielleicht", "okay was ist mit morgen?"} {
		if isExplicitIssueConfirmation(value) {
			t.Errorf("isExplicitIssueConfirmation(%q) = true, want conservative false", value)
		}
	}
}

func TestSeerrMutationAuthorityIsReporterBound(t *testing.T) {
	payload := issuePayload("Kommentar", "bob", "mach das")
	payload["issue"].(map[string]any)["reportedBy_id"] = "reporter-7"
	payload["comment"].(map[string]any)["commentedBy_id"] = "commenter-8"
	if reporterAuthored(payload) {
		t.Fatal("third-party comment was treated as reporter authority")
	}
	if policy := issueMutationPolicy(nil, payload, "comment"); policy != "read_only" {
		t.Fatalf("third-party mutation policy = %q, want read_only", policy)
	}

	payload["comment"].(map[string]any)["commentedBy_username"] = "alice"
	payload["comment"].(map[string]any)["commentedBy_id"] = "reporter-7"
	if !reporterAuthored(payload) {
		t.Fatal("reporter comment was not recognized")
	}
	if actor := trustedIssueActorID(nil, payload, "comment"); actor != "reporter-7" {
		t.Fatalf("trusted reporter actor = %q", actor)
	}
}

func TestSeerrCommentWithoutAuthorIDFailsClosed(t *testing.T) {
	payload := issuePayload("Kommentar", "alice", "ja")
	payload["issue"].(map[string]any)["reportedBy_id"] = "reporter-7"
	delete(payload["comment"].(map[string]any), "commentedBy_id")

	if actor := actorID(payload); actor != "" {
		t.Fatalf("comment actor ID = %q, want empty without commenter identity", actor)
	}
	if reporterAuthored(payload) {
		t.Fatal("comment without a commenter ID inherited reporter authority")
	}
	if policy := issueMutationPolicy(nil, payload, "comment"); policy != "read_only" {
		t.Fatalf("comment mutation policy = %q, want read_only", policy)
	}
}

func TestSeerrWebhookEmailIdentifiesReporterWhenUserIDsAreAbsent(t *testing.T) {
	payload := issuePayload("Kommentar", "alice", "ja")
	issue := payload["issue"].(map[string]any)
	comment := payload["comment"].(map[string]any)
	delete(issue, "reportedBy_id")
	delete(comment, "commentedBy_id")
	issue["reportedBy_email"] = "Alice@example.invalid"
	comment["commentedBy_email"] = "alice@EXAMPLE.invalid"

	if !reporterAuthored(payload) {
		t.Fatal("reporter comment with matching Seerr email was not recognized")
	}
	if policy := issueMutationPolicy(nil, payload, "comment"); policy != "issue_report_and_reporter_comments" {
		t.Fatalf("reporter mutation policy = %q", policy)
	}
	if actor := trustedIssueActorID(nil, payload, "comment"); !strings.HasPrefix(actor, "seerr-email:") || strings.Contains(actor, "alice") {
		t.Fatalf("trusted reporter actor = %q", actor)
	}

	report := issuePayload("New Issue Reported", "", "")
	reportIssue := report["issue"].(map[string]any)
	delete(reportIssue, "reportedBy_id")
	reportIssue["reportedBy_email"] = "alice@example.invalid"
	report["comment"] = nil
	if actor := trustedIssueActorID(nil, report, "reported"); actor != trustedIssueActorID(nil, payload, "comment") {
		t.Fatalf("reported and comment actor identities differ: %q != %q", actor, trustedIssueActorID(nil, payload, "comment"))
	}
}

func TestRevisitReusesReporterIdentityAndAuthority(t *testing.T) {
	payload := issuePayload("Kommentar", "bob", "unrelated")
	payload["issue"].(map[string]any)["reportedBy_id"] = "reporter-7"
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	thread := &IssueThread{
		LastPayload: data,
		Events: []ThreadEvent{
			{Actor: "alice", Message: "Bitte reparieren"},
			{Actor: "bob", Message: "unrelated"},
		},
	}
	if actor := trustedIssueActorID(thread, map[string]any{"event": "revisit"}, "revisit"); actor != "reporter-7" {
		t.Fatalf("revisit actor = %q, want reporter-7", actor)
	}
	if authority := issueAuthority(thread, nil, "revisit"); authority != "Bitte reparieren" {
		t.Fatalf("revisit authority = %q", authority)
	}
	if policy := issueMutationPolicy(thread, nil, "revisit"); policy != "issue_report_and_reporter_comments" {
		t.Fatalf("revisit policy = %q", policy)
	}
}

type fakeResolutionBroker struct {
	authorization review.Authorization
	decision      review.Decision
	run           review.RunContext
	proposal      review.Proposal
	observations  []string
	confirmed     []string
	revoked       []string
}

func (b *fakeResolutionBroker) AuthorizeFollowup(run review.RunContext) (review.Authorization, error) {
	b.run = run
	if b.authorization.ExpiresAt.IsZero() {
		b.authorization.ExpiresAt = time.Now().Add(time.Minute)
	}
	return b.authorization, nil
}

func (b *fakeResolutionBroker) ReviewMutation(_ context.Context, _ string, proposal review.Proposal) (review.Decision, error) {
	b.proposal = proposal
	return b.decision, nil
}

func (b *fakeResolutionBroker) RecordExecution(token, proposalHash, status string, _ []string) error {
	b.observations = append(b.observations, token+":"+proposalHash+":"+status)
	return nil
}

func (b *fakeResolutionBroker) RecordValidation(token, proposalHash, service, path, outcome string) error {
	b.observations = append(b.observations, token+":"+proposalHash+":"+service+":"+path+":"+outcome)
	return nil
}

func (b *fakeResolutionBroker) Confirm(id, actorID, conversationID string) error {
	b.confirmed = append(b.confirmed, id+":"+actorID+":"+conversationID)
	return nil
}

func (b *fakeResolutionBroker) RevokeRun(token string) {
	b.revoked = append(b.revoked, token)
}
