package discord

import (
	"strings"
	"unicode"

	"github.com/bwmarrin/discordgo"
)

const maxDiscordMessageRunes = 1900

func eligibleHumanMessage(message *discordgo.Message, botUserID string) bool {
	if message == nil || message.Author == nil {
		return false
	}
	if strings.TrimSpace(message.GuildID) == "" || strings.TrimSpace(message.ChannelID) == "" || strings.TrimSpace(message.ID) == "" {
		return false
	}
	if message.Author.Bot || message.Author.System || strings.TrimSpace(message.WebhookID) != "" {
		return false
	}
	if message.Author.ID == strings.TrimSpace(botUserID) {
		return false
	}
	return message.Type == discordgo.MessageTypeDefault || message.Type == discordgo.MessageTypeReply
}

func mentionsUser(message *discordgo.Message, userID string) bool {
	userID = strings.TrimSpace(userID)
	if message == nil || userID == "" {
		return false
	}
	for _, mention := range message.Mentions {
		if mention != nil && mention.ID == userID {
			return true
		}
	}
	return strings.Contains(message.Content, "<@"+userID+">") || strings.Contains(message.Content, "<@!"+userID+">")
}

func chunkDiscordMessage(value string) []string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	runes := []rune(value)
	chunks := make([]string, 0, (len(runes)/maxDiscordMessageRunes)+1)
	for len(runes) > maxDiscordMessageRunes {
		cut := preferredChunkBoundary(runes[:maxDiscordMessageRunes])
		chunk := strings.TrimSpace(string(runes[:cut]))
		if chunk != "" {
			chunks = append(chunks, chunk)
		}
		runes = trimLeadingSpace(runes[cut:])
	}
	if chunk := strings.TrimSpace(string(runes)); chunk != "" {
		chunks = append(chunks, chunk)
	}
	return chunks
}

func preferredChunkBoundary(runes []rune) int {
	minimum := len(runes) * 3 / 5
	for i := len(runes) - 1; i >= minimum; i-- {
		if runes[i] == '\n' {
			return i + 1
		}
	}
	for i := len(runes) - 1; i >= minimum; i-- {
		if unicode.IsSpace(runes[i]) {
			return i + 1
		}
	}
	return len(runes)
}

func trimLeadingSpace(value []rune) []rune {
	for len(value) > 0 && unicode.IsSpace(value[0]) {
		value = value[1:]
	}
	return value
}

func safeDiscordMessage(content string, reference *discordgo.MessageReference) *discordgo.MessageSend {
	return &discordgo.MessageSend{
		Content: content,
		AllowedMentions: &discordgo.MessageAllowedMentions{
			Parse:       []discordgo.AllowedMentionType{},
			Roles:       []string{},
			Users:       []string{},
			RepliedUser: false,
		},
		Reference: reference,
	}
}
