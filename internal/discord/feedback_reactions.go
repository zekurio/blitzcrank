package discord

import (
	"context"
	"encoding/json"
	"log"
	"strings"

	"blitzcrank/internal/store"

	"github.com/bwmarrin/discordgo"
)

func (b *Bot) isFeedbackReactionTarget(ctx context.Context, event *discordgo.MessageReactionAdd) bool {
	if event == nil {
		return false
	}
	if _, handled := feedbackReaction(&event.Emoji); !handled {
		return false
	}
	if b.store == nil {
		return false
	}
	messageID := strings.TrimSpace(event.MessageID)
	if messageID == "" {
		return false
	}
	if _, ok, err := b.store.LoadAgentThreadByExternalID(ctx, "discord", messageID); err != nil {
		log.Printf("load discord feedback target failed: message=%s error=%v", messageID, err)
		return false
	} else if ok {
		return true
	}
	channelID := strings.TrimSpace(event.ChannelID)
	if channelID == "" {
		return false
	}
	thread, ok, err := b.store.LoadAgentThreadByExternalID(ctx, "discord", channelID)
	if err != nil {
		log.Printf("load discord feedback channel failed: channel=%s error=%v", channelID, err)
		return false
	}
	return ok && discordThreadHasBotMessage(thread, messageID)
}

func discordThreadHasBotMessage(thread store.AgentThread, messageID string) bool {
	messageID = strings.TrimSpace(messageID)
	if messageID == "" || strings.TrimSpace(thread.LastPayloadJSON) == "" {
		return false
	}
	var payload struct {
		BotMessageID       string   `json:"bot_message_id"`
		LatestBotMessageID string   `json:"latest_bot_message_id"`
		BotMessageIDs      []string `json:"bot_message_ids"`
	}
	if err := json.Unmarshal([]byte(thread.LastPayloadJSON), &payload); err != nil {
		return false
	}
	if strings.TrimSpace(payload.BotMessageID) == messageID || strings.TrimSpace(payload.LatestBotMessageID) == messageID {
		return true
	}
	for _, id := range payload.BotMessageIDs {
		if strings.TrimSpace(id) == messageID {
			return true
		}
	}
	return false
}
