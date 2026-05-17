package openai

import (
	"context"

	"blitzcrank/internal/config"
	"blitzcrank/internal/llm/api"
	"blitzcrank/internal/llm/chatcompletions"
)

type OpenAICompatible struct {
	chat *chatcompletions.Client
}

func New(cfg config.Config) *OpenAICompatible {
	return &OpenAICompatible{
		chat: chatcompletions.New("openai-compatible", cfg.OpenAIAPIKey, cfg.OpenAIBaseURL, nil, chatcompletions.OpenAIChatCompletionPayload),
	}
}

func (c *OpenAICompatible) Chat(ctx context.Context, request api.ChatRequest) (api.ChatResponse, error) {
	return c.chat.Chat(ctx, request)
}
