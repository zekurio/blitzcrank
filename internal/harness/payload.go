package harness

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
)

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
	return "Seerr"
}

func actorID(payload map[string]any) string {
	if _, isComment := payload["comment"].(map[string]any); isComment {
		return seerrIdentity(
			section(payload, "comment"),
			[]string{"commentedBy_id", "commentedBy_userId", "user_id"},
			"commentedBy_email",
		)
	}
	for _, candidate := range []struct {
		section string
		keys    []string
		email   string
	}{
		{"comment", []string{"commentedBy_id", "commentedBy_userId", "user_id"}, "commentedBy_email"},
		{"issue", []string{"reportedBy_id", "reportedBy_userId", "user_id"}, "reportedBy_email"},
		{"request", []string{"requestedBy_id", "requestedBy_userId", "user_id"}, "requestedBy_email"},
	} {
		if value := seerrIdentity(section(payload, candidate.section), candidate.keys, candidate.email); value != "" {
			return value
		}
	}
	return ""
}

func identityFromSection(values map[string]any, keys []string) string {
	for _, key := range keys {
		if value := scalarString(values[key]); value != "" {
			return value
		}
	}
	return ""
}

func seerrIdentity(values map[string]any, idKeys []string, emailKey string) string {
	if value := identityFromSection(values, idKeys); value != "" {
		return value
	}
	if value := strings.ToLower(strings.TrimSpace(stringValue(values, emailKey))); value != "" {
		sum := sha256.Sum256([]byte(value))
		return fmt.Sprintf("seerr-email:%x", sum)
	}
	return ""
}

func reporterName(payload map[string]any) string {
	return stringValue(section(payload, "issue"), "reportedBy_username")
}

func reporterID(payload map[string]any) string {
	issue := section(payload, "issue")
	if value := seerrIdentity(issue, []string{"reportedBy_id", "reportedBy_userId", "user_id"}, "reportedBy_email"); value != "" {
		return value
	}
	return reporterName(payload)
}

func reporterAuthored(payload map[string]any) bool {
	reporter := reporterName(payload)
	if reporter == "" {
		return false
	}
	reporterStableID := reporterID(payload)
	currentStableID := actorID(payload)
	if _, isComment := payload["comment"].(map[string]any); isComment {
		// A comment must carry the commenter's stable identity. Seerr's issue
		// section describes the reporter, not the author of this comment.
		return reporterStableID == currentStableID
	}
	if reporterStableID != "" && currentStableID != "" {
		return reporterStableID == currentStableID
	}
	return strings.EqualFold(reporter, actor(payload))
}

func currentAuthority(payload map[string]any) string {
	if message := stringValue(section(payload, "comment"), "comment_message"); message != "" {
		return message
	}
	return stringValue(payload, "message")
}

func scalarString(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return typed.String()
	case float64:
		return strings.TrimSuffix(strings.TrimSuffix(fmt.Sprintf("%.0f", typed), ".0"), ".")
	case int:
		return fmt.Sprintf("%d", typed)
	case int64:
		return fmt.Sprintf("%d", typed)
	default:
		return ""
	}
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
