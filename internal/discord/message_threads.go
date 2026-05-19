package discord

import (
	"context"
	"log"
	"strings"
	"time"

	"blitzcrank/internal/store"

	"github.com/bwmarrin/discordgo"
)

func (b *Bot) loadDiscordThreadByReplyTarget(ctx context.Context, event *discordgo.MessageCreate) (store.AgentThread, bool, error) {
	return b.loadDiscordThreadByBotMessageID(ctx, messageReplyTargetID(event.Message))
}

func (b *Bot) loadDiscordThreadByBotMessageID(ctx context.Context, messageID string) (store.AgentThread, bool, error) {
	if b.store == nil {
		return store.AgentThread{}, false, nil
	}
	messageID = strings.TrimSpace(messageID)
	if messageID == "" {
		return store.AgentThread{}, false, nil
	}
	thread, ok, err := b.store.LoadAgentThreadByBotMessageID(ctx, "discord", messageID)
	if err != nil || !ok {
		return thread, ok, err
	}
	b.hydrateDiscordThreadContent(&thread)
	return thread, true, nil
}

func (b *Bot) adoptDiscordReplyThread(ctx context.Context, session *discordgo.Session, channel *discordgo.Channel, thread store.AgentThread) {
	if channel == nil || strings.TrimSpace(channel.ID) == "" {
		return
	}
	if b.store != nil {
		thread.ExternalID = channel.ID
		thread.ParentExternalID = channel.ParentID
		thread.UpdatedAt = time.Now().UTC()
		if err := b.store.UpsertAgentThread(ctx, thread); err != nil {
			log.Printf("adopt discord reply thread failed: thread=%s channel=%s error=%v", thread.ThreadID, channel.ID, err)
		}
	}
	title := blitzcrankThreadTitle(thread.Title)
	if session == nil || strings.TrimSpace(title) == "" || channel.Name == title {
		return
	}
	if _, err := session.ChannelEdit(channel.ID, &discordgo.ChannelEdit{Name: title}); err != nil {
		log.Printf("rename discord reply thread failed: thread=%s channel=%s error=%v", thread.ThreadID, channel.ID, err)
	}
}

func blitzcrankThreadTitle(title string) string {
	title = strings.TrimSpace(title)
	if title == "" {
		title = "discussion"
	}
	if strings.HasPrefix(strings.ToLower(title), "blitzcrank:") {
		return title
	}
	const prefix = "blitzcrank: "
	const limit = 100
	if len(prefix)+len(title) > limit {
		runes := []rune(title)
		remaining := limit - len(prefix)
		if len(runes) > remaining {
			title = strings.TrimSpace(string(runes[:remaining]))
		}
	}
	return prefix + title
}
