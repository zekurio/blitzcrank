package agent

import (
	"encoding/json"
	"fmt"
	"strings"
)

func compactLogValue(value any, limit int) string {
	data, err := json.Marshal(value)
	if err != nil {
		return compactLogString(fmt.Sprintf("%v", value), limit)
	}
	return compactLogString(string(data), limit)
}

func compactLogString(value string, limit int) string {
	value = strings.TrimSpace(value)
	if limit > 0 && len(value) > limit {
		return value[:limit] + "..."
	}
	return value
}

func toolResultMessagePayload(result any, limit int) string {
	payload, err := json.Marshal(result)
	if err != nil {
		payload, _ = json.Marshal(map[string]any{
			"ok":    false,
			"error": compactToolError("tool_result", err.Error()),
		})
	}
	if limit <= 0 || len(payload) <= limit {
		return string(payload)
	}
	preview := truncateRunes(string(payload), limit)
	wrapped, err := json.Marshal(map[string]any{
		"ok":              true,
		"truncated":       true,
		"original_bytes":  len(payload),
		"retained_chars":  len([]rune(preview)),
		"result_preview":  preview,
		"compaction_note": "Tool result exceeded the harness context budget; use the preview only and call a narrower tool/query if more detail is needed.",
	})
	if err != nil {
		return `{"ok":false,"error":"tool result exceeded context budget and could not be compacted"}`
	}
	return string(wrapped)
}

func truncateRunes(value string, limit int) string {
	if limit <= 0 {
		return strings.TrimSpace(value)
	}
	runes := []rune(strings.TrimSpace(value))
	if len(runes) <= limit {
		return string(runes)
	}
	return string(runes[:limit]) + "... [truncated]"
}

func toolErrorResult(name string, err error) map[string]any {
	message := strings.TrimSpace(err.Error())
	out := map[string]any{
		"ok":    false,
		"tool":  name,
		"error": compactToolError(name, message),
	}
	if category := toolErrorCategory(message); category != "" {
		out["category"] = category
	}
	return out
}

func compactToolError(name, message string) string {
	if len(message) > 240 {
		return message[:240] + "..."
	}
	return message
}

func toolErrorCategory(message string) string {
	lower := strings.ToLower(message)
	switch {
	case strings.Contains(lower, "not configured"):
		return "not_configured"
	case strings.Contains(lower, "unauthorized") || strings.Contains(lower, "401"):
		return "unauthorized"
	case strings.Contains(lower, "rate") || strings.Contains(lower, "429"):
		return "rate_limited"
	default:
		return ""
	}
}
