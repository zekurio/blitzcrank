package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"blitzcrank/internal/llm"
)

func (a *Agent) TriageDiscordMessage(ctx context.Context, req DiscordTriageRequest) (DiscordTriageResult, error) {
	_, client, model, reasoningEffort, err := a.runtimeForProfile("discord_triage")
	if err != nil {
		return DiscordTriageResult{}, err
	}
	a.mu.RLock()
	prompt := a.discordTriagePrompt
	a.mu.RUnlock()
	response, err := client.Chat(ctx, llm.ChatRequest{
		Model:           model,
		ReasoningEffort: reasoningEffort,
		Messages: []llm.Message{
			{Role: "system", Content: prompt},
			{Role: "user", Content: fmt.Sprintf("Author: %s\nMentioned bot: %t\nMessage:\n%s", req.Author, req.Mention, req.Content)},
		},
	})
	if err != nil {
		return DiscordTriageResult{}, err
	}
	var result DiscordTriageResult
	if err := json.Unmarshal([]byte(extractJSONObject(response.FirstChoice().Message.Content)), &result); err != nil {
		return DiscordTriageResult{}, fmt.Errorf("parse discord triage JSON: %w", err)
	}
	if err := validateDiscordTriageResult(result); err != nil {
		return DiscordTriageResult{}, err
	}
	return result, nil
}

func (a *Agent) SummarizeDiscordThread(ctx context.Context, previousSummary, latestUserMessage, assistantReply string) (string, error) {
	_, client, model, reasoningEffort, err := a.runtimeForProfile("discord_triage")
	if err != nil {
		return "", err
	}
	a.mu.RLock()
	prompt := a.discordSummaryPrompt
	a.mu.RUnlock()
	response, err := client.Chat(ctx, llm.ChatRequest{
		Model:           model,
		ReasoningEffort: reasoningEffort,
		Messages: []llm.Message{
			{Role: "system", Content: prompt},
			{Role: "user", Content: fmt.Sprintf("Previous summary:\n%s\n\nLatest user message:\n%s\n\nAssistant reply:\n%s", previousSummary, latestUserMessage, assistantReply)},
		},
	})
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(response.FirstChoice().Message.Content), nil
}

func validateDiscordTriageResult(result DiscordTriageResult) error {
	action := strings.TrimSpace(result.Action)
	switch action {
	case "ignore", "direct_reply", "support_request", "unsupported", "clarify":
	default:
		return fmt.Errorf("discord triage returned invalid action %q", result.Action)
	}
	if result.Confidence < 0 || result.Confidence > 1 {
		return fmt.Errorf("discord triage returned confidence %.2f outside [0,1]", result.Confidence)
	}
	if action == "support_request" && (!result.Actionable || !result.NeedsAgentRun) {
		return fmt.Errorf("discord triage support_request must be actionable and need an agent run")
	}
	if action == "ignore" && (result.Actionable || result.NeedsAgentRun) {
		return fmt.Errorf("discord triage ignore must not be actionable or need an agent run")
	}
	return nil
}

func extractJSONObject(content string) string {
	content = strings.TrimSpace(content)
	start := strings.Index(content, "{")
	end := strings.LastIndex(content, "}")
	if start >= 0 && end >= start {
		return content[start : end+1]
	}
	return content
}
