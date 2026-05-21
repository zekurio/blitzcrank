package harness

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"blitzcrank/internal/runtimectx"
)

const (
	issuePromptPayloadLimit   = 12000
	issueRecentEventLimit     = 8
	issueRecentRunLimit       = 5
	issueLineValueLimit       = 700
	finalIssueCommentMaxBytes = 1600
)

type issuePromptResult struct {
	Content     string
	Compactions []runtimectx.CompactionEntry
}

func (m *Manager) issuePrompt(thread *IssueThread, payload map[string]any, event string) string {
	return m.issuePromptContext(thread, payload, event).Content
}

func (m *Manager) issuePromptContext(thread *IssueThread, payload map[string]any, event string) issuePromptResult {
	data, _ := json.MarshalIndent(payload, "", "  ")
	payloadRaw := string(data)
	payloadText := truncatePromptText(payloadRaw, issuePromptPayloadLimit)
	reportedMessage := stringValue(payload, "message")
	if reportedMessage == "" {
		reportedMessage = stringValue(section(payload, "comment"), "comment_message")
	}
	eventsText := formatIssueEvents(thread.Events, issueRecentEventLimit)
	runsText := formatIssueRuns(thread.Runs, issueRecentRunLimit)
	content := fmt.Sprintf(`Seerr issue workflow event: %s
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

Use the tools to investigate the issue, apply safe fixes when appropriate, validate the result, and return exactly one final Seerr issue comment body.
If the reported user message is an explicit diagnostic or test instruction, perform a safe read-only tool call when possible and summarize the result.

Required final comment:
- First line must be exactly "RESOLVE_ISSUE: yes" when validation proves the issue should be marked resolved, otherwise exactly "RESOLVE_ISSUE: no". This line is internal and will be stripped before posting.
- Leave one blank line after the RESOLVE_ISSUE line, then write the public Seerr issue comment.
- Use the system language rules: default to German, but if the reporting user clearly wrote the actual issue in another language, write the final comment in that language.
- Return a final, closed-form comment: either the issue was fixed with a short cause/result explanation, or it could not be fixed with a short blocker explanation.
- Use at most two short sentences.
- Answer the latest user message directly and do not repeat earlier bot comments.
- Do not include next steps, manual-action guidance, "please check", "try again", "when available", or requests for the user to confirm.
- Do not mention searches, retries, refreshes, or replacement attempts that were not performed.
- For fixed issues, explain what caused the issue and what was done to fix it.
- For unresolved issues, explain why it could not be fixed; do not instruct the user what to do next.
- For verified external availability blockers, write a natural availability answer instead of failure phrasing like "konnte nicht repariert werden"; for example, say that the German version is available on the verified date and the user has to wait until then.
- For diagnostic/test instructions, report the diagnostic action and result instead of inventing a cause/fix.
- Mention verification only when a fix or diagnostic action was actually checked, and write it as a normal sentence.
- Do not use labeled sections such as "Validierung:", "Ursache:", "Fix:", or "Nächste Schritte:".
- Do not include a signature/header; the harness adds a bracket header with the bot name and model.
- Keep it concise and readable as a Seerr issue comment.

Webhook payload:
%s`, event, thread.IssueID, len(thread.Events), len(thread.Runs), emptyIssueSummary(thread.Summary), reportedMessage, eventsText, runsText, payloadText)

	return issuePromptResult{
		Content:     content,
		Compactions: issuePromptCompactions(thread, payloadRaw, payloadText),
	}
}

func parseIssueResolutionDirective(response string) (string, bool) {
	response = strings.TrimSpace(response)
	first, rest, ok := strings.Cut(response, "\n")
	if !ok {
		return response, false
	}
	key, value, ok := strings.Cut(strings.TrimSpace(first), ":")
	if !ok || !strings.EqualFold(strings.TrimSpace(key), "RESOLVE_ISSUE") {
		return response, false
	}
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "yes", "true":
		return strings.TrimSpace(rest), true
	case "no", "false":
		return strings.TrimSpace(rest), false
	default:
		return response, false
	}
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

func (m *Manager) signedComment(comment string, request Request) string {
	comment = strings.TrimSpace(comment)
	header := m.commentHeader(request)
	if strings.HasPrefix(comment, header) || strings.HasPrefix(comment, m.commentHeaderPrefix()) {
		return comment
	}
	return header + "\n\n" + comment
}

func (m *Manager) signedRunMessage(comment string, todos []TodoItem, request Request) string {
	comment = strings.TrimSpace(comment)
	header := m.commentHeader(request)
	if strings.HasPrefix(comment, header) || strings.HasPrefix(comment, m.commentHeaderPrefix()) {
		return comment
	}
	return renderRunMessage(header, todos, comment)
}

func renderRunMessage(header string, todos []TodoItem, response string) string {
	var parts []string
	if header = strings.TrimSpace(header); header != "" {
		parts = append(parts, header)
	}
	if list := renderTodoList(todos); list != "" {
		parts = append(parts, list)
	}
	if response = strings.TrimSpace(response); response != "" {
		parts = append(parts, response)
	}
	return strings.Join(parts, "\n\n")
}

func renderTodoList(todos []TodoItem) string {
	var lines []string
	for _, item := range todos {
		content := strings.TrimSpace(item.Content)
		if content == "" {
			continue
		}
		mark := " "
		if item.Completed {
			mark = "X"
		}
		lines = append(lines, "["+mark+"] "+content)
	}
	return strings.Join(lines, "\n")
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

func (m *Manager) commentHeader(request ...Request) string {
	name := strings.ToLower(strings.TrimSpace(m.cfg.SeerrBotDisplayName))
	if name == "" {
		name = "blitzcrank"
	}
	model := strings.TrimSpace(m.cfg.PiModelFor("default"))
	effort := ""
	if len(request) > 0 {
		if provider, ok := m.runner.(runtimeInfoProvider); ok {
			resolvedModel, resolvedEffort := provider.RuntimeInfo(request[0])
			if strings.TrimSpace(resolvedModel) != "" {
				model = strings.TrimSpace(resolvedModel)
			}
			effort = strings.TrimSpace(resolvedEffort)
		} else if namer, ok := m.runner.(modelNamer); ok {
			if resolved := strings.TrimSpace(namer.ModelName(request[0])); resolved != "" {
				model = resolved
			}
		}
	}
	if model == "" {
		model = "unknown-model"
	}
	if effort != "" {
		model += " " + effort
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
