package harness

import (
	"fmt"
	"strings"

	"blitzcrank/internal/runtimectx"
)

func issuePromptCompactions(thread *IssueThread, payloadRaw, payloadText string) []runtimectx.CompactionEntry {
	var entries []runtimectx.CompactionEntry
	if omitted := len(thread.Events) - issueRecentEventLimit; omitted > 0 {
		entries = append(entries, runtimectx.NewCompactionEntry(runtimectx.NewCompactionEntryOptions{
			Summary:          fmt.Sprintf("Seerr issue event context compacted: %d older event(s) omitted; rolling summary and %d recent event(s) remain available.", omitted, issueRecentEventLimit),
			FirstKeptEntryID: firstKeptIssueEventEntryID(thread.Events, omitted),
			TokensBefore:     runtimectx.EstimateTextTokens(formatIssueEvents(thread.Events, len(thread.Events))),
			Details: map[string]any{
				"component":       "seerr_recent_events",
				"source":          "seerr_issue_prompt",
				"issue_id":        thread.IssueID,
				"omitted_events":  omitted,
				"retained_events": issueRecentEventLimit,
			},
		}))
	}
	if omitted := len(thread.Runs) - issueRecentRunLimit; omitted > 0 {
		entries = append(entries, runtimectx.NewCompactionEntry(runtimectx.NewCompactionEntryOptions{
			Summary:          fmt.Sprintf("Seerr solver outcome context compacted: %d older run(s) omitted; rolling summary and %d recent run(s) remain available.", omitted, issueRecentRunLimit),
			FirstKeptEntryID: firstKeptIssueRunEntryID(thread.Runs, omitted),
			TokensBefore:     runtimectx.EstimateTextTokens(formatIssueRuns(thread.Runs, len(thread.Runs))),
			Details: map[string]any{
				"component":     "seerr_recent_runs",
				"source":        "seerr_issue_prompt",
				"issue_id":      thread.IssueID,
				"omitted_runs":  omitted,
				"retained_runs": issueRecentRunLimit,
			},
		}))
	}
	if count, firstID := truncatedRecentIssueEventLines(thread.Events); count > 0 {
		entries = append(entries, runtimectx.NewCompactionEntry(runtimectx.NewCompactionEntryOptions{
			Summary:          fmt.Sprintf("Seerr issue event line context compacted: %d recent event message(s) shortened to %d characters.", count, issueLineValueLimit),
			FirstKeptEntryID: firstID,
			TokensBefore:     runtimectx.EstimateTextTokens(formatIssueEvents(thread.Events, issueRecentEventLimit)),
			Details: map[string]any{
				"component":        "seerr_event_line_values",
				"source":           "seerr_issue_prompt",
				"issue_id":         thread.IssueID,
				"truncated_events": count,
				"line_char_cap":    issueLineValueLimit,
			},
		}))
	}
	if count, firstID := truncatedRecentIssueRunLines(thread.Runs); count > 0 {
		entries = append(entries, runtimectx.NewCompactionEntry(runtimectx.NewCompactionEntryOptions{
			Summary:          fmt.Sprintf("Seerr solver outcome line context compacted: %d recent outcome(s) shortened to %d characters.", count, issueLineValueLimit),
			FirstKeptEntryID: firstID,
			TokensBefore:     runtimectx.EstimateTextTokens(formatIssueRuns(thread.Runs, issueRecentRunLimit)),
			Details: map[string]any{
				"component":      "seerr_run_line_values",
				"source":         "seerr_issue_prompt",
				"issue_id":       thread.IssueID,
				"truncated_runs": count,
				"line_char_cap":  issueLineValueLimit,
			},
		}))
	}
	if payloadRaw != payloadText {
		entries = append(entries, runtimectx.NewCompactionEntry(runtimectx.NewCompactionEntryOptions{
			Summary:          fmt.Sprintf("Seerr webhook payload compacted from %d to %d characters for prompt safety.", len([]rune(payloadRaw)), len([]rune(payloadText))),
			FirstKeptEntryID: "webhook_payload:preview",
			TokensBefore:     runtimectx.EstimateTextTokens(payloadRaw),
			Details: map[string]any{
				"component":        "seerr_webhook_payload",
				"source":           "seerr_issue_prompt",
				"issue_id":         thread.IssueID,
				"retained_chars":   len([]rune(payloadText)),
				"original_chars":   len([]rune(payloadRaw)),
				"payload_char_cap": issuePromptPayloadLimit,
			},
		}))
	}
	return entries
}

func truncatedRecentIssueEventLines(events []ThreadEvent) (int, string) {
	start := len(events) - issueRecentEventLimit
	if start < 0 {
		start = 0
	}
	count := 0
	firstID := "seerr_event:latest"
	for _, event := range events[start:] {
		message := strings.TrimSpace(event.Message)
		if len([]rune(message)) <= issueLineValueLimit {
			continue
		}
		if count == 0 {
			firstID = firstKeptIssueEventEntryID([]ThreadEvent{event}, 0)
		}
		count++
	}
	return count, firstID
}

func truncatedRecentIssueRunLines(runs []RunRecord) (int, string) {
	start := len(runs) - issueRecentRunLimit
	if start < 0 {
		start = 0
	}
	count := 0
	firstID := "seerr_run:latest"
	for _, run := range runs[start:] {
		outcome := strings.TrimSpace(run.FinalComment)
		if outcome == "" {
			outcome = strings.TrimSpace(run.Error)
		}
		if len([]rune(outcome)) <= issueLineValueLimit {
			continue
		}
		if count == 0 {
			firstID = firstKeptIssueRunEntryID([]RunRecord{run}, 0)
		}
		count++
	}
	return count, firstID
}

func firstKeptIssueEventEntryID(events []ThreadEvent, omitted int) string {
	if omitted < 0 {
		omitted = 0
	}
	if omitted >= len(events) {
		return "seerr_event:latest"
	}
	event := events[omitted]
	if event.Key != "" {
		return "seerr_event:" + event.Key
	}
	if !event.At.IsZero() {
		return "seerr_event_at:" + event.At.UTC().Format("20060102T150405Z")
	}
	return "seerr_event:latest"
}

func firstKeptIssueRunEntryID(runs []RunRecord, omitted int) string {
	if omitted < 0 {
		omitted = 0
	}
	if omitted >= len(runs) {
		return "seerr_run:latest"
	}
	run := runs[omitted]
	if !run.StartedAt.IsZero() {
		return "seerr_run_at:" + run.StartedAt.UTC().Format("20060102T150405Z")
	}
	return "seerr_run:latest"
}
