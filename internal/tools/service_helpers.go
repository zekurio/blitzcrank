package tools

import (
	"fmt"
	"strconv"
	"strings"
)

func seerrUserMaps(results []any) []map[string]any {
	users := make([]map[string]any, 0, len(results))
	for _, rawUser := range results {
		user, ok := rawUser.(map[string]any)
		if ok {
			users = append(users, user)
		}
	}
	return users
}

func seerrUserID(user map[string]any) string {
	value := strings.TrimSpace(fmt.Sprint(user["id"]))
	if value == "<nil>" {
		return ""
	}
	return value
}

func seerrUserDiscordID(user map[string]any) string {
	if value := strings.TrimSpace(fmt.Sprint(user["discordId"])); value != "" && value != "<nil>" {
		return value
	}
	settings, _ := user["settings"].(map[string]any)
	if settings == nil {
		return ""
	}
	value := strings.TrimSpace(fmt.Sprint(settings["discordId"]))
	if value == "<nil>" {
		return ""
	}
	return value
}

func floatNumber(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case float32:
		return float64(typed)
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	default:
		return 0
	}
}

func parseSeasonNumbers(raw string) []int {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var out []int
	for _, part := range strings.Split(raw, ",") {
		value := strings.TrimSpace(part)
		if value == "" {
			continue
		}
		number, err := strconv.Atoi(value)
		if err != nil || number < 0 {
			continue
		}
		out = append(out, number)
	}
	return out
}
