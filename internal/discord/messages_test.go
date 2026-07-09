package discord

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/bwmarrin/discordgo"
)

func TestEligibleHumanMessage(t *testing.T) {
	base := func() *discordgo.Message {
		return &discordgo.Message{
			ID:        "message",
			ChannelID: "channel",
			GuildID:   "guild",
			Type:      discordgo.MessageTypeDefault,
			Author:    &discordgo.User{ID: "human"},
		}
	}
	tests := []struct {
		name   string
		mutate func(*discordgo.Message)
		want   bool
	}{
		{name: "human default", want: true},
		{name: "human reply", mutate: func(m *discordgo.Message) { m.Type = discordgo.MessageTypeReply }, want: true},
		{name: "bot", mutate: func(m *discordgo.Message) { m.Author.Bot = true }},
		{name: "system user", mutate: func(m *discordgo.Message) { m.Author.System = true }},
		{name: "self", mutate: func(m *discordgo.Message) { m.Author.ID = "blitzcrank" }},
		{name: "webhook", mutate: func(m *discordgo.Message) { m.WebhookID = "webhook" }},
		{name: "direct message", mutate: func(m *discordgo.Message) { m.GuildID = "" }},
		{name: "system message type", mutate: func(m *discordgo.Message) { m.Type = discordgo.MessageTypeChannelPinnedMessage }},
		{name: "missing author", mutate: func(m *discordgo.Message) { m.Author = nil }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			message := base()
			if tt.mutate != nil {
				tt.mutate(message)
			}
			if got := eligibleHumanMessage(message, "blitzcrank"); got != tt.want {
				t.Errorf("eligibleHumanMessage() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestEligibleRecoveredHumanMessageAcceptsFetchedGuildMessage(t *testing.T) {
	message := &discordgo.Message{
		ID:        "message",
		ChannelID: "channel",
		Type:      discordgo.MessageTypeDefault,
		Author:    &discordgo.User{ID: "human"},
	}
	if eligibleHumanMessage(message, "blitzcrank") {
		t.Fatal("normal ingress accepted a message without GuildID")
	}
	if !eligibleRecoveredHumanMessage(message, "blitzcrank") {
		t.Fatal("recovery rejected a fetched guild message without GuildID")
	}
}

func TestMentionsUser(t *testing.T) {
	tests := []struct {
		name    string
		message *discordgo.Message
		want    bool
	}{
		{name: "structured mention", message: &discordgo.Message{Mentions: []*discordgo.User{{ID: "bot"}}}, want: true},
		{name: "text mention", message: &discordgo.Message{Content: "Hallo <@bot>"}, want: true},
		{name: "nickname mention", message: &discordgo.Message{Content: "Hallo <@!bot>"}, want: true},
		{name: "other user", message: &discordgo.Message{Content: "Hallo <@other>"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := mentionsUser(tt.message, "bot"); got != tt.want {
				t.Errorf("mentionsUser() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestChunkDiscordMessage(t *testing.T) {
	value := strings.Repeat("ä", maxDiscordMessageRunes-20) + "\n" + strings.Repeat("🦀", maxDiscordMessageRunes+200)
	chunks := chunkDiscordMessage(value)
	if len(chunks) < 2 {
		t.Fatalf("chunkDiscordMessage() produced %d chunks, want at least 2", len(chunks))
	}
	for index, chunk := range chunks {
		if !utf8.ValidString(chunk) {
			t.Errorf("chunk %d is not valid UTF-8", index)
		}
		if count := len([]rune(chunk)); count > maxDiscordMessageRunes {
			t.Errorf("chunk %d has %d runes, max %d", index, count, maxDiscordMessageRunes)
		}
	}
}

func TestSafeDiscordMessageSuppressesMentions(t *testing.T) {
	reference := &discordgo.MessageReference{MessageID: "message"}
	message := safeDiscordMessage("@everyone <@123>", reference)
	if message.AllowedMentions == nil {
		t.Fatal("AllowedMentions is nil")
	}
	if len(message.AllowedMentions.Parse) != 0 || len(message.AllowedMentions.Users) != 0 || len(message.AllowedMentions.Roles) != 0 {
		t.Errorf("AllowedMentions = %+v, want no allowed mention types or IDs", message.AllowedMentions)
	}
	if message.AllowedMentions.RepliedUser {
		t.Error("reply author mention is enabled")
	}
	if message.Reference != reference {
		t.Error("message reference was not preserved")
	}
}
