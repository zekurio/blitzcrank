package llm

import (
	"encoding/base64"
	"encoding/json"
	"strings"
)

func extractAccountID(tokens ...string) string {
	for _, token := range tokens {
		claims := jwtClaims(token)
		if value, ok := claims["chatgpt_account_id"].(string); ok && value != "" {
			return value
		}
		if nested, ok := claims["https://api.openai.com/auth"].(map[string]any); ok {
			if value, ok := nested["chatgpt_account_id"].(string); ok && value != "" {
				return value
			}
		}
		if organizations, ok := claims["organizations"].([]any); ok && len(organizations) > 0 {
			if org, ok := organizations[0].(map[string]any); ok {
				if value, ok := org["id"].(string); ok && value != "" {
					return value
				}
			}
		}
	}
	return ""
}

func jwtClaims(token string) map[string]any {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return map[string]any{}
	}
	data, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return map[string]any{}
	}
	var claims map[string]any
	if err := json.Unmarshal(data, &claims); err != nil {
		return map[string]any{}
	}
	return claims
}
