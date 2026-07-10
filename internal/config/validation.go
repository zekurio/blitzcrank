package config

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/robfig/cron/v3"
)

func validateStrictConfig(cfg Config) error {
	models := normalizePiModels(cfg.PiModels)
	if cfg.DigestsEnabled {
		if strings.TrimSpace(cfg.DiscordToken) == "" {
			return errors.New("DISCORD_TOKEN is required when digests are enabled")
		}
		if strings.TrimSpace(cfg.TMDBAPIToken) == "" {
			return errors.New("TMDB_API_TOKEN is required when digests are enabled")
		}
		if strings.TrimSpace(cfg.TMDBBaseURL) == "" || strings.TrimSpace(cfg.AniListBaseURL) == "" {
			return errors.New("digest provider base URLs are required when digests are enabled")
		}
		region := strings.TrimSpace(cfg.DigestDefaultRegion)
		if len(region) != 2 || region[0] < 'A' || region[0] > 'Z' || region[1] < 'A' || region[1] > 'Z' {
			return errors.New("DIGEST_DEFAULT_REGION must be an uppercase ISO 3166-1 alpha-2 code")
		}
		if cfg.DigestMaxItems < 1 || cfg.DigestMaxItems > 20 {
			return errors.New("DIGEST_MAX_ITEMS must be between 1 and 20")
		}
		if cfg.DigestRetryDelay <= 0 {
			return errors.New("DIGEST_RETRY_DELAY must be positive")
		}
		if _, err := cron.ParseStandard(strings.TrimSpace(cfg.DigestDispatchSchedule)); err != nil {
			return fmt.Errorf("parse DIGEST_DISPATCH_SCHEDULE: %w", err)
		}
		if _, err := time.LoadLocation(strings.TrimSpace(cfg.Timezone)); err != nil {
			return fmt.Errorf("load digest runtime timezone: %w", err)
		}
	}
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
