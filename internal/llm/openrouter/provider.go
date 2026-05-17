package openrouter

import (
	"context"
	"strings"

	"blitzcrank/internal/config"
	"blitzcrank/internal/llm/api"
	"blitzcrank/internal/llm/chatcompletions"
)

const defaultOpenRouterBaseURL = "https://openrouter.ai/api/v1"

type OpenRouter struct {
	chat *chatcompletions.Client
}

func New(cfg config.Config) *OpenRouter {
	headers := map[string]string{}
	if strings.TrimSpace(cfg.OpenRouterReferer) != "" {
		headers["HTTP-Referer"] = cfg.OpenRouterReferer
	}
	if strings.TrimSpace(cfg.OpenRouterTitle) != "" {
		headers["X-OpenRouter-Title"] = cfg.OpenRouterTitle
	}
	return &OpenRouter{
		chat: chatcompletions.New("openrouter", cfg.OpenRouterAPIKey, openRouterBaseURL(cfg.OpenRouterBaseURL), headers, openRouterChatCompletionPayload),
	}
}

func (c *OpenRouter) Chat(ctx context.Context, request api.ChatRequest) (api.ChatResponse, error) {
	return c.chat.Chat(ctx, request)
}

func openRouterBaseURL(value string) string {
	value = strings.TrimRight(strings.TrimSpace(value), "/")
	if value == "" {
		return defaultOpenRouterBaseURL
	}
	return value
}

func openRouterChatCompletionPayload(request api.ChatRequest) (any, error) {
	payload := chatcompletions.BasePayload(request)
	if effort := chatcompletions.ReasoningEffortForWire(request.ReasoningEffort); effort != "" {
		payload["reasoning"] = map[string]any{"effort": effort}
	}
	return payload, nil
}
