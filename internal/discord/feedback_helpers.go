package discord

import (
	"strings"

	"github.com/bwmarrin/discordgo"
)

func valueString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	default:
		return ""
	}
}

func feedbackEventMessage(record discordFeedbackRecord) string {
	parts := []string{}
	if record.Rating != "" {
		parts = append(parts, "rating="+record.Rating)
	}
	if record.Text != "" {
		parts = append(parts, record.Text)
	}
	return strings.Join(parts, "\n")
}

func feedbackReaction(emoji *discordgo.Emoji) (string, bool) {
	if emoji == nil {
		return "", false
	}
	switch strings.TrimSpace(emoji.APIName()) {
	case "👍":
		return "positive", true
	case "👎":
		return "negative", true
	default:
		return "", false
	}
}

func feedbackButtonCustomID(channelID, messageID string) string {
	return feedbackButtonCustomIDPrefix + strings.TrimSpace(channelID) + ":" + strings.TrimSpace(messageID)
}

func feedbackModalCustomID(channelID, messageID string) string {
	return feedbackModalCustomIDPrefix + strings.TrimSpace(channelID) + ":" + strings.TrimSpace(messageID)
}

func parseFeedbackCustomID(customID, prefix string) (string, string, bool) {
	customID = strings.TrimSpace(customID)
	if !strings.HasPrefix(customID, prefix) {
		return "", "", false
	}
	rest := strings.TrimPrefix(customID, prefix)
	parts := strings.SplitN(rest, ":", 2)
	if len(parts) != 2 {
		return "", "", false
	}
	channelID := strings.TrimSpace(parts[0])
	messageID := strings.TrimSpace(parts[1])
	if channelID == "" || messageID == "" {
		return "", "", false
	}
	return channelID, messageID, true
}

func modalTextInputValue(components []discordgo.MessageComponent, customID string) string {
	for _, component := range components {
		switch row := component.(type) {
		case *discordgo.ActionsRow:
			for _, child := range row.Components {
				if value, ok := modalTextInputComponentValue(child, customID); ok {
					return value
				}
			}
		case discordgo.ActionsRow:
			for _, child := range row.Components {
				if value, ok := modalTextInputComponentValue(child, customID); ok {
					return value
				}
			}
		default:
			if value, ok := modalTextInputComponentValue(component, customID); ok {
				return value
			}
		}
	}
	return ""
}

func modalTextInputComponentValue(component discordgo.MessageComponent, customID string) (string, bool) {
	switch value := component.(type) {
	case *discordgo.TextInput:
		if value.CustomID == customID {
			return value.Value, true
		}
	case discordgo.TextInput:
		if value.CustomID == customID {
			return value.Value, true
		}
	}
	return "", false
}
