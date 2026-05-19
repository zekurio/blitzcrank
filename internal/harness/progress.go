package harness

import (
	"context"
	"log"
	"strings"
	"sync"

	"blitzcrank/internal/agent"
)

type seerrProgressReporter struct {
	manager *Manager
	issueID string
	request agent.Request
	once    sync.Once
}

func (m *Manager) newSeerrProgressReporter(issueID string, request agent.Request) *seerrProgressReporter {
	return &seerrProgressReporter{manager: m, issueID: strings.TrimSpace(issueID), request: request}
}

func (r *seerrProgressReporter) callback(ctx context.Context) func(agent.ProgressEvent) {
	return func(event agent.ProgressEvent) {
		r.update(ctx, event)
	}
}

func (r *seerrProgressReporter) update(ctx context.Context, event agent.ProgressEvent) {
	if r == nil || r.manager == nil || r.issueID == "" || !seerrProgressVisible(event) {
		return
	}
	r.once.Do(func() {
		comment := r.manager.signedComment("Ich prüfe das gerade und melde mich hier mit dem Ergebnis.", r.request)
		if _, err := r.manager.tools.CommentIssue(ctx, r.issueID, comment); err != nil {
			log.Printf("seerr progress comment failed: issue=%s phase=%s error=%v", r.issueID, event.Phase, err)
			return
		}
		r.manager.appendTrace("issues/issue-"+r.issueID+".jsonl", map[string]any{
			"type":        "progress_comment",
			"issue":       r.issueID,
			"phase":       event.Phase,
			"tool_name":   event.ToolName,
			"message":     comment,
			"attribution": r.manager.commentAttribution(),
		})
		log.Printf("seerr progress comment posted: issue=%s phase=%s", r.issueID, event.Phase)
	})
}

func seerrProgressVisible(event agent.ProgressEvent) bool {
	switch strings.TrimSpace(event.Phase) {
	case "start", "model_start", "tools_selected", "tool_start", "approval_wait":
		return true
	default:
		return false
	}
}
