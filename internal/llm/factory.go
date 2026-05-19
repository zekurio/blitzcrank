package llm

import (
	"fmt"
	"strings"

	"blitzcrank/internal/config"
	"blitzcrank/internal/llm/codex"
	"blitzcrank/internal/llm/openai"
	"blitzcrank/internal/llm/openrouter"
)

const (
	ProviderOpenAI           = "openai"
	ProviderOpenAICompatible = "openai-compatible"
	ProviderOpenRouter       = "openrouter"
	ProviderCodexOAuth       = "codex-oauth"
)

func New(cfg config.Config) (Client, error) {
	provider := strings.TrimSpace(cfg.Provider)
	if provider == "" {
		provider = ProviderOpenAICompatible
	}

	switch provider {
	case ProviderOpenAI, ProviderOpenAICompatible:
		switch strings.ToLower(strings.TrimSpace(cfg.OpenAIAuth)) {
		case "codex-oauth", "oauth":
			return codex.New(cfg)
		}
		return openai.New(cfg), nil
	case ProviderOpenRouter:
		return openrouter.New(cfg), nil
	case ProviderCodexOAuth:
		return codex.New(cfg)
	default:
		return nil, fmt.Errorf("unsupported runtime provider %q", cfg.Provider)
	}
}
