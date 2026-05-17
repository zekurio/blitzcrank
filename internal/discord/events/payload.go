package events

import (
	"time"

	"github.com/bwmarrin/discordgo"
)

func MessagePayload(event *discordgo.MessageCreate, parentID string) map[string]any {
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
