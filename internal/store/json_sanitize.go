package store

import (
	"encoding/json"
	"strings"
)

var sqliteContentKeys = map[string]struct{}{
	"bot_reply":           {},
	"comment_message":     {},
	"content":             {},
	"final_comment":       {},
	"final_response":      {},
	"latest_bot_reply":    {},
	"message":             {},
	"source_message_text": {},
	"text":                {},
}

func metadataJSON(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	var decoded any
	if err := json.Unmarshal([]byte(value), &decoded); err != nil {
		return "{}"
	}
	scrubContentKeys(decoded)
	data, err := json.Marshal(decoded)
	if err != nil {
		return "{}"
	}
	return string(data)
}

func scrubContentKeys(value any) {
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if _, content := sqliteContentKeys[strings.ToLower(strings.TrimSpace(key))]; content {
				delete(typed, key)
				continue
			}
			scrubContentKeys(child)
		}
	case []any:
		for _, child := range typed {
			scrubContentKeys(child)
		}
	}
}
