package llm

import (
	"fmt"
	"strings"

	"blitzcrank/internal/config"
)

const (
	ProviderOpenAICompatible = "openai-compatible"
	ProviderCodexOAuth       = "codex-oauth"
)

func New(cfg config.Config) (Client, error) {
	provider := strings.TrimSpace(cfg.LLMProvider)
	if provider == "" {
		provider = ProviderOpenAICompatible
	}

	switch provider {
	case ProviderOpenAICompatible, "api_key", "api-key", "openai", "openrouter":
		return NewOpenAICompatible(cfg), nil
	case ProviderCodexOAuth, "openai-codex", "codex":
		return NewCodexOAuth(cfg)
	default:
		return nil, fmt.Errorf("unsupported LLM_PROVIDER %q", cfg.LLMProvider)
	}
}
