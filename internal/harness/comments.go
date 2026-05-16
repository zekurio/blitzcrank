package harness

import (
	"encoding/json"
	"fmt"
	"strings"

	"blitzcrank/internal/agent"
)

func (m *Manager) issuePrompt(thread *IssueThread, payload map[string]any, event string) string {
	data, _ := json.MarshalIndent(payload, "", "  ")
	reportedMessage := stringValue(payload, "message")
	if reportedMessage == "" {
		reportedMessage = stringValue(section(payload, "comment"), "comment_message")
	}
	return fmt.Sprintf(`Jellyseerr issue workflow event: %s
Issue id: %s
Prior thread events: %d
Prior solver runs: %d
Reported user message:
%s

Use the tools to investigate the issue, apply safe fixes when appropriate, validate the result, and return exactly one final Jellyseerr issue comment body.
If the reported user message is an explicit diagnostic or test instruction, perform a safe read-only tool call when possible and summarize the result.

Required final comment:
- Write in German.
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
%s`, event, thread.IssueID, len(thread.Events), len(thread.Runs), reportedMessage, string(data))
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
	if len(comment) > 1600 {
		return fmt.Errorf("final issue comment is too long: %d bytes", len(comment))
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
