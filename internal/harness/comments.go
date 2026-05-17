package harness

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"blitzcrank/internal/agent"
)

const (
	issuePromptPayloadLimit   = 12000
	issueRecentEventLimit     = 8
	issueRecentRunLimit       = 5
	issueLineValueLimit       = 700
	finalIssueCommentMaxBytes = 1600
)

func (m *Manager) issuePrompt(thread *IssueThread, payload map[string]any, event string) string {
	data, _ := json.MarshalIndent(payload, "", "  ")
	payloadText := truncatePromptText(string(data), issuePromptPayloadLimit)
	reportedMessage := stringValue(payload, "message")
	if reportedMessage == "" {
		reportedMessage = stringValue(section(payload, "comment"), "comment_message")
	}
	return fmt.Sprintf(`Jellyseerr issue workflow event: %s
Issue id: %s
Prior thread events: %d
Prior solver runs: %d

Rolling issue summary:
%s

Reported user message:
%s

Recent thread events:
%s

Recent solver outcomes:
%s

Use the tools to investigate the issue, apply safe fixes when appropriate, validate the result, and return exactly one final Jellyseerr issue comment body.
If the reported user message is an explicit diagnostic or test instruction, perform a safe read-only tool call when possible and summarize the result.

Required final comment:
- Use the system language rules: default to German, but if the reporting user clearly wrote the actual issue in another language, write the final comment in that language.
- Return a final, closed-form comment: either the issue was fixed with a short cause/result explanation, or it could not be fixed with a short blocker explanation.
- Use at most two short sentences.
- Answer the latest user message directly and do not repeat earlier bot comments.
- Do not include next steps, manual-action guidance, "please check", "try again", "when available", or requests for the user to confirm.
- Do not mention searches, retries, refreshes, or replacement attempts that were not performed.
- For fixed issues, explain what caused the issue and what was done to fix it.
- For unresolved issues, explain why it could not be fixed; do not instruct the user what to do next.
- For diagnostic/test instructions, report the diagnostic action and result instead of inventing a cause/fix.
- Mention verification only when a fix or diagnostic action was actually checked, and write it as a normal sentence.
- Do not use labeled sections such as "Validierung:", "Ursache:", "Fix:", or "Nächste Schritte:".
- Do not include a signature/header; the harness adds a bracket header with the bot name and model.
- Keep it concise and readable as a Jellyseerr issue comment.

Webhook payload:
%s`, event, thread.IssueID, len(thread.Events), len(thread.Runs), emptyIssueSummary(thread.Summary), reportedMessage, formatIssueEvents(thread.Events, issueRecentEventLimit), formatIssueRuns(thread.Runs, issueRecentRunLimit), payloadText)
}

func emptyIssueSummary(summary string) string {
	summary = strings.TrimSpace(summary)
	if summary == "" {
		return "(none yet)"
	}
	return summary
}

func formatIssueEvents(events []ThreadEvent, limit int) string {
	if limit < 1 {
		limit = issueRecentEventLimit
	}
	start := len(events) - limit
	if start < 0 {
		start = 0
	}
	var lines []string
	for _, event := range events[start:] {
		message := strings.TrimSpace(event.Message)
		if message == "" {
			message = "(no user message)"
		}
		actor := strings.TrimSpace(event.Actor)
		if actor == "" {
			actor = "unknown"
		}
		lines = append(lines, fmt.Sprintf("- %s at %s by %s: %s", event.Type, formatPromptTime(event.At), actor, truncatePromptText(message, issueLineValueLimit)))
	}
	if len(lines) == 0 {
		return "(none)"
	}
	return strings.Join(lines, "\n")
}

func formatIssueRuns(runs []RunRecord, limit int) string {
	if limit < 1 {
		limit = issueRecentRunLimit
	}
	start := len(runs) - limit
	if start < 0 {
		start = 0
	}
	var lines []string
	for _, run := range runs[start:] {
		status := strings.TrimSpace(run.CompletionReason)
		if status == "" {
			status = "completed"
		}
		outcome := strings.TrimSpace(run.FinalComment)
		if outcome == "" {
			outcome = strings.TrimSpace(run.Error)
		}
		if outcome == "" {
			outcome = "(no final text)"
		}
		lines = append(lines, fmt.Sprintf("- %s at %s: %s", status, formatPromptTime(run.StartedAt), truncatePromptText(outcome, issueLineValueLimit)))
	}
	if len(lines) == 0 {
		return "(none)"
	}
	return strings.Join(lines, "\n")
}

func buildIssueSummary(thread *IssueThread) string {
	var lines []string
	if len(thread.Events) > 0 {
		event := thread.Events[len(thread.Events)-1]
		message := strings.TrimSpace(event.Message)
		if message == "" {
			message = "(no user message)"
		}
		lines = append(lines, "Latest event: "+event.Type+" by "+nonEmpty(event.Actor, "unknown")+" - "+truncatePromptText(message, 260))
	}
	if len(thread.Runs) > 0 {
		run := thread.Runs[len(thread.Runs)-1]
		status := nonEmpty(run.CompletionReason, "completed")
		outcome := strings.TrimSpace(run.FinalComment)
		if outcome == "" {
			outcome = strings.TrimSpace(run.Error)
		}
		if outcome == "" {
			outcome = "(no final text)"
		}
		lines = append(lines, "Latest solver outcome: "+status+" - "+truncatePromptText(outcome, 500))
	}
	if len(lines) == 0 {
		return ""
	}
	return truncatePromptText(strings.Join(lines, "\n"), 1000)
}

func nonEmpty(value, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	return value
}

func formatPromptTime(value time.Time) string {
	if value.IsZero() {
		return "unknown time"
	}
	return value.UTC().Format(time.RFC3339)
}

func truncatePromptText(value string, limit int) string {
	value = strings.TrimSpace(value)
	if limit <= 0 {
		return value
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "... [truncated]"
}

func (m *Manager) signedComment(comment string, request agent.Request) string {
	comment = strings.TrimSpace(comment)
	header := m.commentHeader(request)
	if strings.HasPrefix(comment, header) || strings.HasPrefix(comment, m.commentHeaderPrefix()) {
		return comment
	}
	return header + "\n\n" + comment
}

func (m *Manager) validateFinalIssueComment(comment string) error {
	comment = strings.TrimSpace(comment)
	if comment == "" {
		return fmt.Errorf("final issue comment is empty")
	}
	lower := strings.ToLower(comment)
	if strings.HasPrefix(comment, m.commentHeaderPrefix()) {
		return fmt.Errorf("final issue comment must not include the bot header")
	}
	for _, marker := range []string{
		"webhook payload:",
		"tool result",
		"tool_results",
		"```",
		"{\"",
	} {
		if strings.Contains(lower, marker) {
			return fmt.Errorf("final issue comment appears to expose internal output")
		}
	}
	for _, label := range []string{
		"validierung:",
		"ursache:",
		"fix:",
		"prüfung:",
		"pruefung:",
		"nächste schritte:",
		"naechste schritte:",
	} {
		if strings.Contains(lower, label) {
			return fmt.Errorf("final issue comment contains a disallowed section label")
		}
	}
	for _, phrase := range []string{
		"bitte prüfen",
		"bitte pruefen",
		"try again",
		"let me know",
		"gib bescheid",
		"manuell prüfen",
		"manuell pruefen",
		"sobald verfügbar",
		"sobald verfuegbar",
	} {
		if strings.Contains(lower, phrase) {
			return fmt.Errorf("final issue comment contains open-ended guidance")
		}
	}
	return nil
}

func (m *Manager) validateSignedFinalIssueComment(comment string) error {
	comment = strings.TrimSpace(comment)
	if len(comment) > finalIssueCommentMaxBytes {
		return fmt.Errorf("final issue comment is too long after header: %d bytes", len(comment))
	}
	return nil
}

func (m *Manager) commentHeader(request ...agent.Request) string {
	name := strings.ToLower(strings.TrimSpace(m.cfg.SeerrBotDisplayName))
	if name == "" {
		name = "blitzcrank"
	}
	model := strings.TrimSpace(m.cfg.Model)
	if len(request) > 0 {
		if namer, ok := m.runner.(modelNamer); ok {
			if resolved := strings.TrimSpace(namer.ModelName(request[0])); resolved != "" {
				model = resolved
			}
		}
	}
	if model == "" {
		model = "unknown-model"
	}
	if strings.EqualFold(strings.TrimSpace(m.cfg.CodexServiceTier), "fast") {
		model += " fast"
	}
	return "[" + name + " w/ " + model + "]"
}

func (m *Manager) commentHeaderPrefix() string {
	name := strings.ToLower(strings.TrimSpace(m.cfg.SeerrBotDisplayName))
	if name == "" {
		name = "blitzcrank"
	}
	return "[" + name + " w/ "
}

func (m *Manager) commentAttribution() string {
	if m.cfg.SeerrBotUserID != "" {
		return "bot_user:" + m.cfg.SeerrBotUserID
	}
	return "signed:" + m.cfg.SeerrBotDisplayName
}

func (m *Manager) botAuthored(payload map[string]any) bool {
	comment := section(payload, "comment")
	username := stringValue(comment, "commentedBy_username")
	message := strings.TrimSpace(stringValue(comment, "comment_message"))
	if username != "" && strings.EqualFold(username, m.cfg.SeerrBotDisplayName) {
		return true
	}
	return strings.HasPrefix(message, m.commentHeaderPrefix())
}
