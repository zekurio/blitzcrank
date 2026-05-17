package discord

import (
	"strings"

	"blitzcrank/internal/agent"
)

func (b *Bot) discordAttribution(request agent.Request) string {
	model := strings.TrimSpace(b.cfg.Model)
	if resolved := strings.TrimSpace(b.agent.ModelName(request)); resolved != "" {
		model = resolved
	}
	if model == "" {
		model = "unknown-model"
	}
	return "discord:" + model
}
