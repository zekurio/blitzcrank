package tools

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"
)

const (
	threadHistoryDefaultLimit       = 5
	threadHistoryMaxLimit           = 10
	threadHistorySnippetsPerThread  = 3
	threadHistorySnippetMaxRunes    = 320
	threadHistoryScannerBufferBytes = 4 * 1024 * 1024
)

type threadHistorySearchResult struct {
	Query          string               `json:"query"`
	Source         string               `json:"source"`
	SearchedFiles  int                  `json:"searched_files"`
	MatchedThreads int                  `json:"matched_threads"`
	Matches        []threadHistoryMatch `json:"matches"`
}

type threadHistoryMatch struct {
	ThreadID       string                 `json:"thread_id"`
	Source         string                 `json:"source"`
	TracePath      string                 `json:"trace_path"`
	Score          int                    `json:"score"`
	UpdatedAt      string                 `json:"updated_at,omitempty"`
	RecordsMatched int                    `json:"records_matched"`
	Snippets       []threadHistorySnippet `json:"snippets"`
}

type threadHistorySnippet struct {
	RecordType string `json:"record_type,omitempty"`
	At         string `json:"at,omitempty"`
	Text       string `json:"text"`
}

func (r *Registry) threadHistorySearch(args map[string]any) (threadHistorySearchResult, error) {
	root := strings.TrimSpace(r.cfg.ThreadsDirectory)
	if root == "" {
		return threadHistorySearchResult{}, fmt.Errorf("threads directory is not configured")
	}
	query := strings.TrimSpace(stringArg(args, "query"))
	if query == "" {
		return threadHistorySearchResult{}, fmt.Errorf("query is required")
	}
	limit, err := intArg(args, "limit")
	if err != nil {
		return threadHistorySearchResult{}, err
	}
	if limit <= 0 {
		limit = threadHistoryDefaultLimit
	}
	if limit > threadHistoryMaxLimit {
		limit = threadHistoryMaxLimit
	}
	source := normalizeThreadHistorySource(stringArg(args, "source"))
	if source == "" {
		return threadHistorySearchResult{}, fmt.Errorf("source must be all, discord, issues, or automations")
	}
	terms := threadHistoryTerms(query)
	if len(terms) == 0 {
		return threadHistorySearchResult{}, fmt.Errorf("query must include at least one searchable term")
	}
	excludeThreadID := strings.TrimSpace(stringArg(args, "exclude_thread_id"))

	result := threadHistorySearchResult{
		Query:  query,
		Source: source,
	}
	matches := map[string]*threadHistoryMatch{}
	walkRoot := root
	if source != "all" {
		walkRoot = filepath.Join(root, source)
	}
	if _, err := os.Stat(walkRoot); err != nil {
		if os.IsNotExist(err) {
			return result, nil
		}
		return threadHistorySearchResult{}, fmt.Errorf("inspect thread history directory %s: %w", walkRoot, err)
	}
	err = filepath.WalkDir(walkRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if !threadHistoryTraceFile(path) {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return fmt.Errorf("resolve trace path %s: %w", path, err)
		}
		threadID, traceSource := threadHistoryTraceID(rel)
		if source != "all" && traceSource != source {
			return nil
		}
		if sameThreadHistoryID(threadID, excludeThreadID) {
			return nil
		}
		result.SearchedFiles++
		fileMatch, err := searchThreadHistoryFile(path, filepath.ToSlash(rel), threadID, traceSource, query, terms)
		if err != nil {
			return err
		}
		if fileMatch == nil {
			return nil
		}
		matches[fileMatch.ThreadID] = fileMatch
		return nil
	})
	if err != nil {
		return threadHistorySearchResult{}, fmt.Errorf("search thread history: %w", err)
	}

	result.Matches = make([]threadHistoryMatch, 0, len(matches))
	for _, match := range matches {
		result.Matches = append(result.Matches, *match)
	}
	sort.Slice(result.Matches, func(i, j int) bool {
		if result.Matches[i].Score != result.Matches[j].Score {
			return result.Matches[i].Score > result.Matches[j].Score
		}
		return result.Matches[i].UpdatedAt > result.Matches[j].UpdatedAt
	})
	result.MatchedThreads = len(result.Matches)
	if len(result.Matches) > limit {
		result.Matches = result.Matches[:limit]
	}
	return result, nil
}

func normalizeThreadHistorySource(source string) string {
	source = strings.ToLower(strings.TrimSpace(source))
	if source == "" {
		return "all"
	}
	switch source {
	case "all":
		return source
	case "discord", "discord_thread", "discord_threads", "discord_interactions":
		return "discord"
	case "issue", "issues", "seerr", "seerr_issue", "seerr_issues":
		return "issues"
	case "automation", "automations", "automation_cron", "cron":
		return "automations"
	default:
		return ""
	}
}

func threadHistoryTraceFile(path string) bool {
	base := filepath.Base(path)
	return strings.HasSuffix(base, ".jsonl") && !strings.HasSuffix(base, ".compactions.jsonl")
}

func threadHistoryTraceID(rel string) (string, string) {
	rel = filepath.ToSlash(rel)
	parts := strings.Split(rel, "/")
	if len(parts) == 0 {
		return strings.TrimSuffix(rel, ".jsonl"), ""
	}
	source := strings.TrimSpace(parts[0])
	base := strings.TrimSuffix(filepath.Base(rel), ".jsonl")
	switch source {
	case "issues":
		if issueID := strings.TrimPrefix(base, "issue-"); issueID != base {
			return "issue:" + issueID, source
		}
	case "discord":
		return "discord:" + base, source
	case "automations":
		return "automation:" + base, source
	}
	if source == "" {
		return base, source
	}
	return source + ":" + base, source
}

func sameThreadHistoryID(a, b string) bool {
	a = normalizeThreadHistoryID(a)
	b = normalizeThreadHistoryID(b)
	return a != "" && b != "" && a == b
}

func normalizeThreadHistoryID(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.TrimPrefix(value, "discord:")
	value = strings.TrimPrefix(value, "issue:")
	value = strings.TrimPrefix(value, "issues:")
	value = strings.TrimPrefix(value, "automation:")
	value = strings.TrimPrefix(value, "automations:")
	value = strings.TrimPrefix(value, "issue-")
	return value
}

func threadHistoryTerms(query string) []string {
	seen := map[string]bool{}
	var terms []string
	for _, term := range strings.FieldsFunc(strings.ToLower(query), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	}) {
		term = strings.TrimSpace(term)
		if len(term) < 2 || threadHistoryStopWord(term) || seen[term] {
			continue
		}
		seen[term] = true
		terms = append(terms, term)
	}
	return terms
}

func threadHistoryStopWord(term string) bool {
	switch term {
	case "the", "and", "for", "with", "from", "that", "this", "was", "were", "ist", "der", "die", "das", "und", "mit", "ein", "eine", "von", "den", "dem":
		return true
	default:
		return false
	}
}

func searchThreadHistoryFile(path, rel, threadID, source, query string, terms []string) (*threadHistoryMatch, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open thread trace %s: %w", path, err)
	}
	defer file.Close()

	info, _ := file.Stat()
	match := &threadHistoryMatch{
		ThreadID:  threadID,
		Source:    source,
		TracePath: rel,
	}
	if info != nil {
		match.UpdatedAt = info.ModTime().UTC().Format(time.RFC3339)
	}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), threadHistoryScannerBufferBytes)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			return nil, fmt.Errorf("parse thread trace %s: %w", path, err)
		}
		score := threadHistoryRecordScore(query, terms, line, record)
		if score == 0 {
			continue
		}
		match.Score += score
		match.RecordsMatched++
		if at := threadHistoryRecordTime(record); at != "" && at > match.UpdatedAt {
			match.UpdatedAt = at
		}
		if len(match.Snippets) >= threadHistorySnippetsPerThread {
			continue
		}
		match.Snippets = append(match.Snippets, threadHistorySnippet{
			RecordType: firstNonEmptyString(record, "type", "event", "event_type", "source_event_type"),
			At:         threadHistoryRecordTime(record),
			Text:       threadHistoryRecordSnippet(query, terms, record),
		})
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read thread trace %s: %w", path, err)
	}
	if match.RecordsMatched == 0 {
		return nil, nil
	}
	return match, nil
}

func threadHistoryRecordScore(query string, terms []string, line string, record map[string]any) int {
	normalizedLine := strings.ToLower(line)
	safeText := strings.ToLower(strings.Join(threadHistorySafeStrings(record), " "))
	score := 0
	if phrase := strings.ToLower(strings.TrimSpace(query)); phrase != "" && strings.Contains(normalizedLine, phrase) {
		score += 5
	}
	for _, term := range terms {
		if strings.Contains(normalizedLine, term) {
			score++
		}
		if strings.Contains(safeText, term) {
			score += 2
		}
	}
	return score
}

func threadHistorySafeStrings(record map[string]any) []string {
	keys := []string{
		"type",
		"event",
		"event_type",
		"source_event_type",
		"tool_name",
		"title",
		"source_message_text",
		"message",
		"final_response",
		"final_comment",
		"summary",
		"completion_reason",
		"error",
		"result",
		"result_summary",
		"reply",
		"content",
	}
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		if value := valueString(record[key]); value != "" {
			out = append(out, value)
		}
	}
	return out
}

func threadHistoryRecordSnippet(query string, terms []string, record map[string]any) string {
	text := strings.Join(threadHistorySafeStrings(record), " ")
	if strings.TrimSpace(text) == "" {
		return "(match found in trace payload or metadata; raw details omitted)"
	}
	needle := strings.TrimSpace(query)
	if !strings.Contains(strings.ToLower(text), strings.ToLower(needle)) && len(terms) > 0 {
		needle = terms[0]
	}
	return snippetAround(text, needle, threadHistorySnippetMaxRunes)
}

func snippetAround(text, needle string, maxRunes int) string {
	text = strings.Join(strings.Fields(text), " ")
	runes := []rune(text)
	if maxRunes <= 0 || len(runes) <= maxRunes {
		return text
	}
	lower := strings.ToLower(text)
	index := strings.Index(lower, strings.ToLower(strings.TrimSpace(needle)))
	if index < 0 {
		return string(runes[:maxRunes]) + "..."
	}
	runeIndex := len([]rune(text[:index]))
	start := runeIndex - maxRunes/3
	if start < 0 {
		start = 0
	}
	end := start + maxRunes
	if end > len(runes) {
		end = len(runes)
		start = end - maxRunes
		if start < 0 {
			start = 0
		}
	}
	prefix := ""
	if start > 0 {
		prefix = "..."
	}
	suffix := ""
	if end < len(runes) {
		suffix = "..."
	}
	return prefix + string(runes[start:end]) + suffix
}

func threadHistoryRecordTime(record map[string]any) string {
	for _, key := range []string{"created_at", "at", "completed_at", "completed", "started_at", "compaction_timestamp"} {
		value := valueString(record[key])
		if value == "" {
			continue
		}
		if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
			return parsed.UTC().Format(time.RFC3339)
		}
		return value
	}
	return ""
}

func firstNonEmptyString(record map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := valueString(record[key]); value != "" {
			return value
		}
	}
	return ""
}

func valueString(value any) string {
	if value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}
