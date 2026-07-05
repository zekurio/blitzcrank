package config

import (
	"errors"
	"fmt"
	"strings"
)

func validateStrictConfig(cfg Config) error {
	if cfg.SeerrWebhookListenAddr != "" {
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
	return nil
}
