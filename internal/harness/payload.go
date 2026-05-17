package harness

import "strings"

func classify(payload map[string]any) string {
	if _, ok := payload["issue"].(map[string]any); !ok {
		return "unknown"
	}
	text := strings.ToLower(strings.Join([]string{
		stringValue(payload, "notification_type"),
		stringValue(payload, "event"),
		stringValue(payload, "subject"),
	}, " "))
	switch {
	case strings.Contains(text, "comment"), strings.Contains(text, "kommentar"):
		return "comment"
	case strings.Contains(text, "resolved"), strings.Contains(text, "gelöst"), strings.Contains(text, "gelost"):
		return "resolved"
	case strings.Contains(text, "reopened"), strings.Contains(text, "wieder"):
		return "reopened"
	case strings.Contains(text, "reported"), strings.Contains(text, "gemeldet"), strings.Contains(text, "new"):
		return "reported"
	default:
		return "reported"
	}
}

func issueID(payload map[string]any) string {
	return stringValue(section(payload, "issue"), "issue_id")
}

func actor(payload map[string]any) string {
	for _, candidate := range []struct {
		section string
		key     string
	}{
		{"comment", "commentedBy_username"},
		{"issue", "reportedBy_username"},
		{"request", "requestedBy_username"},
	} {
		if value := stringValue(section(payload, candidate.section), candidate.key); value != "" {
			return value
		}
	}
	return "Jellyseerr"
}

func section(payload map[string]any, name string) map[string]any {
	value, _ := payload[name].(map[string]any)
	if value == nil {
		return map[string]any{}
	}
	return value
}

func stringValue(payload map[string]any, key string) string {
	value, _ := payload[key].(string)
	return strings.TrimSpace(value)
}
