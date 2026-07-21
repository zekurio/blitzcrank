package config

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

func validateStrictConfig(cfg Config) error {
	if socket := strings.TrimSpace(cfg.AnvilControlSocket); socket != "" && !filepath.IsAbs(socket) {
		return errors.New("ANVIL_CONTROL_SOCKET must be absolute")
	}
	models := normalizePiModels(cfg.PiModels)
	if len(cfg.DiscordWatchedChannelIDs) > 0 {
		if strings.TrimSpace(cfg.DiscordToken) == "" {
			return errors.New("DISCORD_TOKEN is required when watched Discord channels are configured")
		}
		if strings.TrimSpace(models["discord_triage"]) == "" {
			return errors.New("pi.models.discord_triage is required when watched Discord channels are configured")
		}
	}
	seerrWebhookEnabled := strings.TrimSpace(cfg.HTTPListenAddr) != "" || strings.TrimSpace(cfg.SeerrWebhookListenAddr) != ""
	if seerrWebhookEnabled {
		if cfg.SeerrBaseURL == "" || cfg.SeerrAPIKey == "" {
			return errors.New("SEERR_BASE_URL and SEERR_API_KEY are required when the Seerr webhook server is enabled")
		}
		if cfg.SeerrWebhookPath == "" || !strings.HasPrefix(cfg.SeerrWebhookPath, "/") {
			return fmt.Errorf("SEERR_WEBHOOK_PATH must start with /")
		}
	}
	if cfg.SeerrRevisitMax < 0 {
		return errors.New("SEERR_REVISIT_MAX must be zero or positive")
	}
	if cfg.DiscordMutationBudget < 0 {
		return errors.New("DISCORD_MUTATION_BUDGET must be zero or positive")
	}
	if cfg.DiscordMutationBudget > 3 {
		return errors.New("DISCORD_MUTATION_BUDGET must not exceed 3")
	}
	if cfg.SeerrMutationBudget < 0 {
		return errors.New("SEERR_MUTATION_BUDGET must be zero or positive")
	}
	if cfg.SeerrMutationBudget > 5 {
		return errors.New("SEERR_MUTATION_BUDGET must not exceed 5")
	}
	if cfg.AutomationMutationBudget < 0 {
		return errors.New("AUTOMATION_MUTATION_BUDGET must be zero or positive")
	}
	if cfg.AutomationMutationBudget > 10 {
		return errors.New("AUTOMATION_MUTATION_BUDGET must not exceed 10")
	}
	if cfg.ReviewCapacity < 0 || (cfg.ReviewCapacity == 0 && cfg.ReviewTimeout > 0) {
		return errors.New("REVIEW_CAPACITY must be positive")
	}
	if cfg.DiscordTriageTimeout < 0 || cfg.DiscordRunTimeout < 0 || cfg.DiscordDebounce < 0 || cfg.DiscordThreadInactivity < 0 || cfg.DiscordRetention < 0 {
		return errors.New("Discord durations must be zero or positive")
	}
	if cfg.ReviewTimeout < 0 || cfg.ConfirmationTTL < 0 {
		return errors.New("review durations must be zero or positive")
	}
	mutationReviewRequired :=
		(len(cfg.DiscordWatchedChannelIDs) > 0 && cfg.DiscordMutationBudget > 0) ||
			(seerrWebhookEnabled && cfg.SeerrMutationBudget > 0) ||
			(cfg.AutomationsEnabled && cfg.AutomationMutationBudget > 0)
	if mutationReviewRequired && strings.TrimSpace(models["review"]) == "" {
		return errors.New("pi.models.review is required when a mutation-capable workflow is enabled")
	}
	return nil
}
