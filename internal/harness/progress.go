package harness

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
)

type seerrProgressReporter struct {
	manager   *Manager
	issueID   string
	request   Request
	mu        sync.Mutex
	todos     []TodoItem
	commentID string
	status    string
	turns     int
	steps     int
}

func (m *Manager) newSeerrProgressReporter(issueID string, request Request) *seerrProgressReporter {
	return &seerrProgressReporter{manager: m, issueID: strings.TrimSpace(issueID), request: request}
}

func (r *seerrProgressReporter) callback(ctx context.Context) func(ProgressEvent) {
	return func(event ProgressEvent) {
		r.update(ctx, event)
	}
}

func (r *seerrProgressReporter) update(ctx context.Context, event ProgressEvent) {
	if r == nil || r.manager == nil || r.issueID == "" || !seerrProgressVisible(event) {
		return
	}
	r.mu.Lock()
	if strings.TrimSpace(event.Phase) == "status" {
		status := strings.TrimSpace(event.Message)
		invalidStatus := strings.ContainsAny(status, "\r\n") || len(status) > 240 || r.manager.validateFinalIssueComment(status) != nil
		if r.status != "" || !r.manager.cfg.SeerrTransientRunComments || invalidStatus {
			r.mu.Unlock()
			return
		}
		r.status = status
		comment := r.manager.signedRunMessage(status, nil, r.request)
		r.mu.Unlock()
		if err := r.postOrUpdate(ctx, comment); err != nil {
			log.Printf("seerr progress comment failed: issue=%s phase=%s error=%v", r.issueID, event.Phase, err)
			return
		}
		log.Printf("seerr progress comment posted: issue=%s phase=%s", r.issueID, event.Phase)
		return
	}
	if strings.TrimSpace(event.Phase) == "tool_done" {
		if !r.manager.cfg.SeerrTransientRunComments || strings.TrimSpace(event.ToolName) == "report_progress" {
			r.mu.Unlock()
			return
		}
		r.steps++
		status := strings.TrimSuffix(strings.TrimSpace(r.status), ".")
		if status == "" {
			r.mu.Unlock()
			return
		}
		comment := r.manager.signedRunMessage(
			fmt.Sprintf("%s – %s abgeschlossen.", status, completedStepsLabel(r.steps)),
			r.todos, r.request)
		r.mu.Unlock()
		if err := r.postOrUpdate(ctx, comment); err != nil {
			log.Printf("seerr progress comment failed: issue=%s phase=%s error=%v", r.issueID, event.Phase, err)
			return
		}
		log.Printf("seerr progress comment posted: issue=%s phase=%s", r.issueID, event.Phase)
		return
	}
	r.todos = append([]TodoItem(nil), event.Todos...)
	response := seerrProgressResponse(event)
	if r.turns > 0 && strings.TrimSpace(response) != "" {
		response = "[...]\n\n" + response
	}
	r.turns++
	comment := r.manager.signedRunMessage(response, r.todos, r.request)
	r.mu.Unlock()
	if err := r.postOrUpdate(ctx, comment); err != nil {
		log.Printf("seerr progress comment failed: issue=%s phase=%s error=%v", r.issueID, event.Phase, err)
		return
	}
	log.Printf("seerr progress comment posted: issue=%s phase=%s", r.issueID, event.Phase)
}

func completedStepsLabel(steps int) string {
	if steps == 1 {
		return "1 Schritt"
	}
	return fmt.Sprintf("%d Schritte", steps)
}

func (r *seerrProgressReporter) render(response string) string {
	if r == nil || r.manager == nil {
		return strings.TrimSpace(response)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.turns > 0 && strings.TrimSpace(response) != "" {
		response = "[...]\n\n" + strings.TrimSpace(response)
	}
	comment := r.manager.signedRunMessage(response, r.todos, r.request)
	return comment
}

func (r *seerrProgressReporter) postOrUpdate(ctx context.Context, comment string) error {
	comment = strings.TrimSpace(comment)
	if comment == "" {
		return nil
	}
	r.mu.Lock()
	commentID := r.commentID
	r.mu.Unlock()
	if commentID != "" {
		_, err := r.manager.tools.UpdateIssueComment(ctx, r.issueID, commentID, comment)
		return err
	}
	result, err := r.manager.tools.CommentIssue(ctx, r.issueID, comment)
	if err != nil {
		return err
	}
	if id := seerrCommentID(result); id != "" {
		r.mu.Lock()
		r.commentID = id
		r.mu.Unlock()
	}
	return nil
}

func (r *seerrProgressReporter) delete(ctx context.Context) error {
	if r == nil || r.manager == nil || r.issueID == "" {
		return nil
	}
	r.mu.Lock()
	commentID := r.commentID
	r.commentID = ""
	r.mu.Unlock()
	if commentID == "" {
		return nil
	}
	_, err := r.manager.tools.DeleteIssueComment(ctx, r.issueID, commentID)
	return err
}

func seerrProgressVisible(event ProgressEvent) bool {
	switch strings.TrimSpace(event.Phase) {
	case "status", "assistant_turn", "tool_done":
		return true
	default:
		return false
	}
}

func (r *seerrProgressReporter) latestTodos() []TodoItem {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]TodoItem(nil), r.todos...)
}

func seerrCommentID(value any) string {
	switch typed := value.(type) {
	case map[string]any:
		if comments, ok := typed["comments"].([]any); ok {
			for i := len(comments) - 1; i >= 0; i-- {
				comment, ok := comments[i].(map[string]any)
				if !ok {
					continue
				}
				if id := strings.TrimSpace(fmt.Sprint(comment["id"])); id != "" && id != "<nil>" {
					return id
				}
			}
		}
		for _, key := range []string{"id", "commentId", "comment_id"} {
			if id := strings.TrimSpace(fmt.Sprint(typed[key])); id != "" && id != "<nil>" {
				return id
			}
		}
	}
	return ""
}

func seerrProgressResponse(event ProgressEvent) string {
	var sections []string
	if reasoning := strings.TrimSpace(event.Reasoning); reasoning != "" {
		sections = append(sections, reasoning)
	}
	response := strings.TrimSpace(event.CurrentResponse)
	if response != "" {
		sections = append(sections, response)
	}
	if len(event.ToolCalls) == 0 {
		if len(sections) > 0 {
			return strings.Join(sections, "\n\n")
		}
		return strings.TrimSpace(event.Message)
	}
	var lines []string
	for _, call := range event.ToolCalls {
		if strings.TrimSpace(call.Name) != "" {
			lines = append(lines, "Tool call: "+strings.TrimSpace(call.Name))
		}
	}
	if len(lines) > 0 {
		sections = append(sections, strings.Join(lines, "\n"))
	}
	return strings.Join(sections, "\n\n")
}
