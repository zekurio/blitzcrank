package automation

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"blitzcrank/internal/config"
)

const (
	automationHistoryLimit         = 8
	automationManualLedgerLimit    = 100
	automationHistoryMaxEntryBytes = 6000
)

func (s *Scheduler) promptWithHistory(task Task, cfg config.Config) string {
	history := s.automationHistory(task.Name, cfg)
	if strings.TrimSpace(history) == "" {
		return task.Prompt
	}
	return fmt.Sprintf(`Prior automation history for %s from local thread trace %s, newest first:
%s

Use this history as the operational record. The persistent manual-intervention ledger is preserved across context compaction and long-running automation threads. Do not repeat actions that a prior run already marked as needing manual intervention unless the current live tool evidence clearly shows the blocker was resolved.

Current automation prompt:
%s`, task.Name, filepath.Join(cfg.ThreadsDirectory, "automations", task.Name+".jsonl"), history, task.Prompt)
}

func (s *Scheduler) automationHistory(name string, cfg config.Config) string {
	path := filepath.Join(cfg.ThreadsDirectory, "automations", name+".jsonl")
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 2*1024*1024)
	records, ledger := readAutomationHistory(scanner)
	if len(records) == 0 && ledger == "" {
		return ""
	}
	if ledger != "" {
		records = append([]string{"Persistent manual-intervention ledger from all local thread records:\n" + ledger}, records...)
	}
	return strings.Join(records, "\n\n")
}

func readAutomationHistory(scanner *bufio.Scanner) ([]string, string) {
	records := make([]string, 0, automationHistoryLimit)
	manualLedger := newAutomationManualLedger(automationManualLedgerLimit)
	for scanner.Scan() {
		record := automationHistoryRecord(scanner.Bytes())
		if record == "" {
			continue
		}
		manualLedger.AddFromText(record)
		records = append(records, record)
		if len(records) > automationHistoryLimit {
			records = records[1:]
		}
	}
	reverseStrings(records)
	return records, manualLedger.Text()
}

func reverseStrings(values []string) {
	for i, j := 0, len(values)-1; i < j; i, j = i+1, j-1 {
		values[i], values[j] = values[j], values[i]
	}
}

type automationManualLedger struct {
	limit   int
	keys    map[string]struct{}
	entries []string
}

func newAutomationManualLedger(limit int) *automationManualLedger {
	return &automationManualLedger{
		limit:   limit,
		keys:    make(map[string]struct{}, limit),
		entries: make([]string, 0, limit),
	}
}

func (l *automationManualLedger) AddFromText(text string) {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if !strings.Contains(line, "MANUAL_INTERVENTION_REQUIRED") {
			continue
		}
		l.add(line)
	}
}

func (l *automationManualLedger) add(line string) {
	line = strings.TrimLeft(line, "-* \t")
	key := automationManualLedgerKey(line)
	if key == "" {
		return
	}
	if _, ok := l.keys[key]; ok {
		return
	}
	l.keys[key] = struct{}{}
	l.entries = append(l.entries, line)
	if l.limit > 0 && len(l.entries) > l.limit {
		delete(l.keys, automationManualLedgerKey(l.entries[0]))
		l.entries = l.entries[1:]
	}
}

func (l *automationManualLedger) Text() string {
	if len(l.entries) == 0 {
		return ""
	}
	lines := make([]string, 0, len(l.entries))
	for i := len(l.entries) - 1; i >= 0; i-- {
		lines = append(lines, "- "+l.entries[i])
	}
	return strings.Join(lines, "\n")
}

func automationManualLedgerKey(value string) string {
	value = strings.ToLower(value)
	var builder strings.Builder
	lastSpace := true
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			builder.WriteRune(r)
			lastSpace = false
			continue
		}
		if !lastSpace {
			builder.WriteByte(' ')
			lastSpace = true
		}
	}
	return strings.TrimSpace(builder.String())
}

func automationHistoryRecord(data []byte) string {
	var record map[string]any
	if err := json.Unmarshal(data, &record); err != nil {
		return ""
	}
	switch record["type"] {
	case "automation_run":
		return automationRunSummary(record)
	case "discord_automation_report":
		return automationReportSummary(record)
	default:
		return ""
	}
}

func automationRunSummary(record map[string]any) string {
	when := firstString(record, "completed", "completed_at", "started_at")
	result := strings.TrimSpace(firstString(record, "result", "error"))
	if result == "" {
		return ""
	}
	result = compactAutomationHistoryText(result)
	if when == "" {
		return result
	}
	return when + "\n" + result
}

func automationReportSummary(record map[string]any) string {
	when := firstString(record, "at", "created_at")
	message := strings.TrimSpace(firstString(record, "message"))
	if message == "" {
		return ""
	}
	message = compactAutomationHistoryText(message)
	if when == "" {
		return "Discord automation thread report:\n" + message
	}
	return when + "\nDiscord automation thread report:\n" + message
}

func firstString(record map[string]any, keys ...string) string {
	for _, key := range keys {
		value, _ := record[key].(string)
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func compactAutomationHistoryText(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= automationHistoryMaxEntryBytes {
		return value
	}
	return value[:automationHistoryMaxEntryBytes] + "\n[truncated]"
}
