package config

import (
	"errors"
	"fmt"
	"strings"
)

func validateStrictConfig(cfg Config) error {
	defaultProfile := cfg.RuntimeProfile("default")
	if err := validateRuntimeProfile(cfg, defaultProfile); err != nil {
		return err
	}
	if defaultProfile.Model == "" {
		return errors.New("AGENT_DEFAULT_MODEL is required")
	}
	if cfg.SeerrWebhookListenAddr != "" {
		if cfg.SeerrBaseURL == "" || cfg.SeerrAPIKey == "" {
			return errors.New("SEERR_BASE_URL and SEERR_API_KEY are required when the Seerr webhook server is enabled")
		}
		if cfg.SeerrWebhookPath == "" || !strings.HasPrefix(cfg.SeerrWebhookPath, "/") {
			return fmt.Errorf("SEERR_WEBHOOK_PATH must start with /")
		}
	}
	return nil
}

func validateRuntimeProfile(cfg Config, profile RuntimeProfile) error {
	switch strings.TrimSpace(profile.Provider) {
	case "openai-compatible":
		if strings.TrimSpace(cfg.OpenAIAPIKey) == "" {
			return errors.New("OPENAI_API_KEY is required for openai-compatible default runtime provider")
		}
	case "openrouter":
		if strings.TrimSpace(cfg.OpenRouterAPIKey) == "" {
			return errors.New("OPENROUTER_API_KEY is required for openrouter default runtime provider")
		}
	case "codex-oauth":
	default:
		return fmt.Errorf("unsupported default runtime provider %q", profile.Provider)
	}
	return nil
}
