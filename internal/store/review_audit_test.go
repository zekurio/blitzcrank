package store

import (
	"context"
	"strings"
	"testing"
	"time"

	"blitzcrank/internal/review"
)

func TestRecordMutationReviewPersistsOnlyAuditMetadata(t *testing.T) {
	ctx := context.Background()
	state, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()

	reviewedAt := time.Now().UTC().Truncate(time.Millisecond)
	record := review.AuditRecord{
		ProposalHash:   "sha256:proposal",
		RunID:          "run-1",
		Source:         "discord_thread",
		ActorID:        "actor-1",
		ConversationID: "thread-1",
		Service:        "sonarr",
		Method:         "POST",
		Capability:     "sonarr.manual_import",
		OutcomeCode:    "approved",
		Risk:           review.RiskMedium,
		Verdict:        review.VerdictApprove,
		MutationIndex:  2,
		Confirmed:      true,
		ReviewedAt:     reviewedAt,
		Duration:       1250 * time.Millisecond,
		Error:          strings.Repeat("x", 700),
	}
	if err := state.RecordMutationReview(ctx, record); err != nil {
		t.Fatalf("RecordMutationReview() error = %v", err)
	}

	var proposalHash, runID, source, actorID, conversationID, service, method, capability string
	var risk, verdict, outcomeCode, storedError string
	var mutationIndex, confirmed, durationMS int
	var storedReviewedAt time.Time
	err = state.db.QueryRowContext(ctx, `
SELECT proposal_hash,run_id,source,actor_id,conversation_id,service,method,capability,
       risk,verdict,outcome_code,mutation_index,confirmed,reviewed_at,duration_ms,error
FROM mutation_reviews
`).Scan(&proposalHash, &runID, &source, &actorID, &conversationID, &service, &method, &capability, &risk, &verdict, &outcomeCode, &mutationIndex, &confirmed, scanTime(&storedReviewedAt), &durationMS, &storedError)
	if err != nil {
		t.Fatalf("load mutation review: %v", err)
	}
	if proposalHash != record.ProposalHash || runID != record.RunID || source != record.Source || actorID != record.ActorID || conversationID != record.ConversationID {
		t.Fatalf("stored identity = hash %q run %q source %q actor %q conversation %q", proposalHash, runID, source, actorID, conversationID)
	}
	if service != "sonarr" || method != "POST" || capability != "sonarr.manual_import" || risk != "medium" || verdict != "approve" || outcomeCode != "approved" {
		t.Fatalf("stored decision = service %q method %q capability %q risk %q verdict %q outcome %q", service, method, capability, risk, verdict, outcomeCode)
	}
	if mutationIndex != 2 || confirmed != 1 || durationMS != 1250 || !storedReviewedAt.Equal(reviewedAt) || len([]rune(storedError)) != 512 {
		t.Fatalf("stored timing = index %d confirmed %d duration %d reviewed %v error runes %d", mutationIndex, confirmed, durationMS, storedReviewedAt, len([]rune(storedError)))
	}
}

func TestMutationReviewSchemaExcludesProposalContent(t *testing.T) {
	ctx := context.Background()
	state, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()

	rows, err := state.db.QueryContext(ctx, `SELECT name FROM pragma_table_info('mutation_reviews')`)
	if err != nil {
		t.Fatalf("inspect mutation_reviews: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var column string
		if err := rows.Scan(&column); err != nil {
			t.Fatalf("scan mutation_reviews column: %v", err)
		}
		switch strings.ToLower(column) {
		case "path", "body", "purpose", "authority", "evidence", "reason", "token", "content":
			t.Fatalf("mutation_reviews unexpectedly persists proposal content in %q", column)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("inspect mutation_reviews rows: %v", err)
	}
}

func TestRecordMutationExecutionAndValidation(t *testing.T) {
	ctx := context.Background()
	state, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()

	executedAt := time.Now().UTC().Truncate(time.Millisecond)
	if err := state.RecordMutationExecution(ctx, review.ExecutionAuditRecord{
		ProposalHash: "sha256:proposal", RunID: "run-1", Status: review.ExecutionSucceeded, ExecutedAt: executedAt,
	}); err != nil {
		t.Fatalf("RecordMutationExecution() error = %v", err)
	}
	if err := state.RecordMutationValidation(ctx, review.ValidationAuditRecord{
		ProposalHash: "sha256:proposal", RunID: "run-1", Service: "sonarr", Outcome: review.ValidationConfirmed, ObservedAt: executedAt.Add(time.Second),
	}); err != nil {
		t.Fatalf("RecordMutationValidation() error = %v", err)
	}

	var executionStatus string
	var storedExecutedAt time.Time
	if err := state.db.QueryRowContext(ctx, `SELECT status,executed_at FROM mutation_executions WHERE proposal_hash=? AND run_id=?`, "sha256:proposal", "run-1").Scan(&executionStatus, scanTime(&storedExecutedAt)); err != nil {
		t.Fatalf("load mutation execution: %v", err)
	}
	if executionStatus != review.ExecutionSucceeded || !storedExecutedAt.Equal(executedAt) {
		t.Fatalf("stored execution = %q at %v", executionStatus, storedExecutedAt)
	}

	var service, outcome string
	var observedAt time.Time
	if err := state.db.QueryRowContext(ctx, `SELECT service,outcome,observed_at FROM mutation_validations WHERE proposal_hash=? AND run_id=?`, "sha256:proposal", "run-1").Scan(&service, &outcome, scanTime(&observedAt)); err != nil {
		t.Fatalf("load mutation validation: %v", err)
	}
	if service != "sonarr" || outcome != review.ValidationConfirmed || !observedAt.Equal(executedAt.Add(time.Second)) {
		t.Fatalf("stored validation = service %q outcome %q at %v", service, outcome, observedAt)
	}
}
