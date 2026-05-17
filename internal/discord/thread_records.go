package discord

import (
	"context"
	"encoding/json"
	"time"

	discordevents "blitzcrank/internal/discord/events"
	"blitzcrank/internal/store"

	"github.com/bwmarrin/discordgo"
)

type recordDiscordThreadRequest struct {
	ThreadID      string
	ParentID      string
	RootMessageID string
	Title         string
	Event         *discordgo.MessageCreate
	EventType     string
	Content       string
	ToolGroups    []string
}

func (b *Bot) recordDiscordThread(ctx context.Context, request recordDiscordThreadRequest) error {
	if b.store == nil {
		return nil
	}
	now := time.Now().UTC()
	payload := discordevents.MessagePayload(request.Event, request.ParentID)
	if len(request.ToolGroups) > 0 {
		payload["tool_groups"] = request.ToolGroups
	}
	data, _ := json.Marshal(payload)
	thread := store.AgentThread{
		ThreadID:         discordThreadID(request.ThreadID),
		Source:           "discord",
		ExternalID:       request.ThreadID,
		ParentExternalID: request.ParentID,
		RootExternalID:   request.RootMessageID,
		Status:           "active",
		Title:            request.Title,
		CreatedAt:        now,
		UpdatedAt:        now,
		LastPayloadJSON:  string(data),
	}
	if err := b.store.UpsertAgentThread(ctx, thread); err != nil {
		return err
	}
	b.appendDiscordTrace(thread.ThreadID, map[string]any{
		"type":                "discord_thread",
		"thread_id":           thread.ThreadID,
		"discord_thread_id":   request.ThreadID,
		"parent_channel_id":   request.ParentID,
		"root_message_id":     request.RootMessageID,
		"title":               request.Title,
		"created_at":          now.Format(time.RFC3339Nano),
		"last_payload":        payload,
		"source_event_type":   request.EventType,
		"source_message_text": request.Content,
	})
	return b.recordDiscordEvent(ctx, thread.ThreadID, request.Event, request.EventType, request.Content)
}

func (b *Bot) recordDiscordEvent(ctx context.Context, threadID string, event *discordgo.MessageCreate, eventType, content string) error {
	if b.store == nil {
		return nil
	}
	payload := discordevents.MessagePayload(event, "")
	data, _ := json.Marshal(payload)
	record := store.AgentThreadEvent{
		ThreadID:          threadID,
		EventType:         eventType,
		Actor:             event.Author.Username,
		ActorID:           event.Author.ID,
		Message:           content,
		ExternalMessageID: event.ID,
		PayloadJSON:       string(data),
		CreatedAt:         time.Now().UTC(),
	}
	if err := b.store.InsertAgentThreadEvent(ctx, record); err != nil {
		return err
	}
	b.appendDiscordTrace(threadID, map[string]any{
		"type":                "discord_event",
		"thread_id":           threadID,
		"event_type":          eventType,
		"actor":               record.Actor,
		"actor_id":            record.ActorID,
		"message":             content,
		"external_message_id": event.ID,
		"created_at":          record.CreatedAt.Format(time.RFC3339Nano),
		"payload":             payload,
	})
	return nil
}

func (b *Bot) loadDiscordThread(ctx context.Context, externalID string) (store.AgentThread, bool, error) {
	if b.store == nil {
		return store.AgentThread{}, false, nil
	}
	return b.store.LoadAgentThreadByExternalID(ctx, "discord", externalID)
}
