package store

import (
	"context"

	"blitzcrank/internal/review"
)

var _ review.AuditSink = (*Store)(nil)
var _ review.ExecutionAuditSink = (*Store)(nil)
var _ review.ValidationAuditSink = (*Store)(nil)

// RecordMutationReview persists enforcement metadata only. The reviewed path,
// request body, authority text, evidence, reviewer prose, and broker token are
// deliberately absent from the schema.
func (s *Store) RecordMutationReview(ctx context.Context, record review.AuditRecord) error {
	confirmed := 0
	if record.Confirmed {
		confirmed = 1
	}
	_, err := s.db.ExecContext(ctx, `
INSERT INTO mutation_reviews(
  proposal_hash,run_id,source,actor_id,conversation_id,service,method,capability,
  risk,verdict,outcome_code,mutation_index,confirmed,reviewed_at,duration_ms,error
)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`, record.ProposalHash, record.RunID, record.Source, record.ActorID, record.ConversationID, record.Service, record.Method, record.Capability, string(record.Risk), string(record.Verdict), record.OutcomeCode, record.MutationIndex, confirmed, formatTime(record.ReviewedAt), record.Duration.Milliseconds(), storedSanitizedError(record.Error))
	return err
}

func (s *Store) RecordMutationExecution(ctx context.Context, record review.ExecutionAuditRecord) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO mutation_executions(proposal_hash,run_id,status,executed_at)
VALUES(?,?,?,?)
ON CONFLICT(proposal_hash,run_id) DO UPDATE SET status=excluded.status,executed_at=excluded.executed_at
`, record.ProposalHash, record.RunID, record.Status, formatTime(record.ExecutedAt))
	return err
}

func (s *Store) RecordMutationValidation(ctx context.Context, record review.ValidationAuditRecord) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO mutation_validations(proposal_hash,run_id,service,outcome,observed_at)
VALUES(?,?,?,?,?)
`, record.ProposalHash, record.RunID, record.Service, record.Outcome, formatTime(record.ObservedAt))
	return err
}
