package agent

import (
	"fmt"
	"strings"

	"blitzcrank/internal/config"
	"blitzcrank/internal/llm"
)

const (
	contextCharsPerToken       = 4
	compactedToolOutputChars   = 2000
	compactedMessageHeadChars  = 1200
	compactedMessageNoticeText = "[Context compaction: middle content omitted to fit the selected model context window.]"
)

func compactMessagesForBudget(budget config.ContextBudget, messages []llm.Message) []llm.Message {
	if !budget.AutoCompact || budget.UsableTokens <= 0 || estimateMessagesTokens(messages) <= budget.UsableTokens {
		return messages
	}
	out := append([]llm.Message(nil), messages...)

	for i := 0; i < len(out)-1; i++ {
		if out[i].Role != "tool" {
			continue
		}
		out[i].Content = compactTextTail(out[i].Content, compactedToolOutputChars, "[Context compaction: older tool output omitted.]")
	}
	if estimateMessagesTokens(out) <= budget.UsableTokens {
		return out
	}

	for i := 0; i < len(out)-1; i++ {
		if out[i].Role != "assistant" {
			continue
		}
		out[i].Content = compactTextTail(out[i].Content, compactedToolOutputChars, "[Context compaction: older assistant content omitted.]")
	}
	if estimateMessagesTokens(out) <= budget.UsableTokens {
		return out
	}

	userIndex := -1
	for i := len(out) - 1; i >= 0; i-- {
		if out[i].Role == "user" {
			userIndex = i
			break
		}
	}
	if userIndex < 0 {
		return out
	}

	otherTokens := estimateMessagesTokens(append(out[:userIndex:userIndex], out[userIndex+1:]...))
	availableTokens := budget.UsableTokens - otherTokens - estimateTextTokens(compactedMessageNoticeText) - 16
	if availableTokens < 1 {
		out[userIndex].Content = compactedMessageNoticeText
		return out
	}
	preserveTokens := budget.PreserveRecentTokens
	if preserveTokens < 1 || preserveTokens > availableTokens {
		preserveTokens = availableTokens
	}
	out[userIndex].Content = compactTextHeadTail(out[userIndex].Content, compactedMessageHeadChars, preserveTokens*contextCharsPerToken, compactedMessageNoticeText)
	return out
}

func estimateMessagesTokens(messages []llm.Message) int {
	total := 0
	for _, message := range messages {
		total += estimateTextTokens(message.Role)
		total += estimateTextTokens(message.Content)
		total += estimateTextTokens(message.ToolCallID)
		for _, call := range message.ToolCalls {
			total += estimateTextTokens(call.ID)
			total += estimateTextTokens(call.Type)
			total += estimateTextTokens(call.Function.Name)
			total += estimateTextTokens(call.Function.Arguments)
		}
	}
	return total
}

func estimateTextTokens(text string) int {
	text = strings.TrimSpace(text)
	if text == "" {
		return 0
	}
	return (len(text) + contextCharsPerToken - 1) / contextCharsPerToken
}

func compactTextTail(text string, maxChars int, notice string) string {
	text = strings.TrimSpace(text)
	if len(text) <= maxChars || maxChars < 1 {
		return text
	}
	tail := text[len(text)-maxChars:]
	return fmt.Sprintf("%s\n\n%s", notice, strings.TrimSpace(tail))
}

func compactTextHeadTail(text string, headChars, tailChars int, notice string) string {
	text = strings.TrimSpace(text)
	if headChars < 0 {
		headChars = 0
	}
	if tailChars < 0 {
		tailChars = 0
	}
	if len(text) <= headChars+tailChars+len(notice)+4 {
		return text
	}
	head := ""
	if headChars > 0 {
		head = strings.TrimSpace(text[:min(headChars, len(text))])
	}
	tail := ""
	if tailChars > 0 && tailChars < len(text) {
		tail = strings.TrimSpace(text[len(text)-tailChars:])
	}
	parts := []string{}
	if head != "" {
		parts = append(parts, head)
	}
	parts = append(parts, notice)
	if tail != "" {
		parts = append(parts, tail)
	}
	return strings.Join(parts, "\n\n")
}
