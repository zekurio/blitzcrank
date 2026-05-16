package discord

import (
	"strings"
	"time"

	"blitzcrank/internal/agent"

	"github.com/bwmarrin/discordgo"
)

func discordEventPayload(event *discordgo.MessageCreate, parentID string) map[string]any {
	payload := map[string]any{
		"channel_id": event.ChannelID,
		"message_id": event.ID,
		"guild_id":   event.GuildID,
		"timestamp":  event.Timestamp.Format(time.RFC3339Nano),
	}
	if parentID != "" {
		payload["parent_channel_id"] = parentID
	}
	if event.Author != nil {
		payload["author_id"] = event.Author.ID
		payload["author_username"] = event.Author.Username
	}
	return payload
}

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
