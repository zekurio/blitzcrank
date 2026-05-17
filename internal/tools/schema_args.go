package tools

import (
	"fmt"
	"math"
	"net/url"
	"strconv"
	"strings"
)

func objectSchema(properties map[string]any, required []string) map[string]any {
	if required == nil {
		required = []string{}
	}
	return map[string]any{
		"type":                 "object",
		"properties":           properties,
		"required":             required,
		"additionalProperties": false,
	}
}

func stringSchema(description string) map[string]any {
	return map[string]any{"type": "string", "description": description}
}

func stringArg(args map[string]any, key string) string {
	value, _ := args[key].(string)
	return strings.TrimSpace(value)
}

func intArg(args map[string]any, key string) (int, error) {
	switch value := args[key].(type) {
	case nil:
		return 0, nil
	case float64:
		if math.Trunc(value) != value {
			return 0, fmt.Errorf("%s must be an integer", key)
		}
		return int(value), nil
	case int:
		return value, nil
	case string:
		text := strings.TrimSpace(value)
		if text == "" {
			return 0, nil
		}
		parsed, err := strconv.Atoi(text)
		if err != nil {
			return 0, fmt.Errorf("%s must be an integer", key)
		}
		return parsed, nil
	default:
		return 0, fmt.Errorf("%s must be an integer", key)
	}
}

func boolSchema(description string) map[string]any {
	return map[string]any{"type": "boolean", "description": description}
}

func boolArg(args map[string]any, key string) (bool, error) {
	switch value := args[key].(type) {
	case nil:
		return false, nil
	case bool:
		return value, nil
	case string:
		text := strings.TrimSpace(value)
		if text == "" {
			return false, nil
		}
		parsed, err := strconv.ParseBool(text)
		if err != nil {
			return false, fmt.Errorf("%s must be a boolean", key)
		}
		return parsed, nil
	default:
		return false, fmt.Errorf("%s must be a boolean", key)
	}
}

func numberSchema(description string) map[string]any {
	return map[string]any{"type": "number", "description": description}
}

func pathID(args map[string]any, key string) string {
	return url.PathEscape(stringArg(args, key))
}
