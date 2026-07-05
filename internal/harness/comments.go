package harness

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

const (
	issuePromptPayloadLimit   = 12000
	issueRecentEventLimit     = 8
	issueRecentRunLimit       = 5
	issueLineValueLimit       = 700
	finalIssueCommentMaxBytes = 1600
)

type issuePromptResult struct {
	Content string
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
	instructions := `Use the Pi system prompt to investigate the issue, apply safe fixes when appropriate, validate the result, and return exactly one final response in Blitzcrank's directive format.
If the reported user message is an explicit diagnostic or test instruction, perform a safe read-only tool call when possible and summarize the result.`
	if event == "revisit" {
		reason := strings.TrimSpace(thread.RevisitReason)
		if reason == "" {
			reason = "(none recorded)"
		}
		instructions = fmt.Sprintf(`This is a revisit you scheduled earlier with REVISIT_IN, not a new user message.
Your recorded reason for this revisit:
%s

Re-verify that pending work with read-only calls first and only act on what the reason names.
If validation now confirms the issue is solved, post a short confirmation and use RESOLVE_ISSUE: yes.
If the fix is technically complete but only the reporter can confirm the user-visible result, briefly ask whether everything works now and whether the issue can be closed, and use RESOLVE_ISSUE: no.
If the pending work is still in progress, re-schedule with REVISIT_IN and an updated REVISIT_REASON, and add a public comment only if there is user-visible news.
If you do not re-schedule, Blitzcrank will not revisit this issue again on its own.`, reason)
	}
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

%s

Webhook payload:
%s`, event, thread.IssueID, len(thread.Events), len(thread.Runs), emptyIssueSummary(thread.Summary), reportedMessage, eventsText, runsText, instructions, payloadText)

	return issuePromptResult{Content: content}
}

type issueRunDecision struct {
	Action        string
	ResolveIssue  bool
	Comment       string
	RevisitIn     time.Duration
	RevisitReason string
}

func parseIssueRunDecision(response string) issueRunDecision {
	response = strings.TrimSpace(response)
	lines := strings.Split(response, "\n")
	key, value, ok := strings.Cut(strings.TrimSpace(lines[0]), ":")
	if !ok || !strings.EqualFold(strings.TrimSpace(key), "RESOLVE_ISSUE") {
		return commentOnlyDecision(response)
	}
	decision := issueRunDecision{}
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "yes", "true":
		decision.ResolveIssue = true
	case "no", "false":
		decision.ResolveIssue = false
	default:
		return commentOnlyDecision(response)
	}
	rest := lines[1:]
directives:
	for len(rest) > 0 {
		trimmed := strings.TrimSpace(rest[0])
		if trimmed == "" {
			rest = rest[1:]
			continue
		}
		key, value, ok := strings.Cut(trimmed, ":")
		if !ok {
			break
		}
		switch strings.ToUpper(strings.TrimSpace(key)) {
		case "REVISIT_IN":
			if delay, err := time.ParseDuration(strings.TrimSpace(value)); err == nil && delay > 0 {
				decision.RevisitIn = delay
			}
		case "REVISIT_REASON":
			decision.RevisitReason = strings.TrimSpace(value)
		default:
			break directives
		}
		rest = rest[1:]
	}
	decision.Comment = strings.TrimSpace(strings.Join(rest, "\n"))
	decision.Action = "post"
	if decision.Comment == "" {
		decision.Action = "none"
	}
	return decision
}

func commentOnlyDecision(response string) issueRunDecision {
	action := "post"
	if response == "" {
		action = "none"
	}
	return issueRunDecision{Action: action, Comment: response}
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
	model = displayModelName(model)
	if model == "" {
		model = "unknown-model"
	}
	if effort != "" {
		model += " " + effort
	}
	return "[" + name + " w/ " + model + "]"
}

func displayModelName(model string) string {
	model = strings.TrimSpace(model)
	if i := strings.LastIndex(model, "/"); i >= 0 {
		model = strings.TrimSpace(model[i+1:])
	}
	return model
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
