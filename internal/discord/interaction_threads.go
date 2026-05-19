package discord

import (
	"context"
	"encoding/json"
	"log"
	"strings"
	"time"

	"blitzcrank/internal/store"
)

func (b *Bot) recordDiscordInteractionThread(ctx context.Context, request interactionThreadRecord) {
	if b.store == nil || strings.TrimSpace(request.ThreadID) == "" {
		return
	}
	now := time.Now().UTC()
	if err := b.store.UpsertAgentThread(ctx, newInteractionAgentThread(request, now)); err != nil {
		log.Printf("record discord interaction thread failed: thread=%s error=%v", request.ThreadID, err)
		return
	}
	if err := b.store.InsertAgentThreadEvent(ctx, newInteractionAgentEvent(request, now)); err != nil {
		log.Printf("record discord interaction event failed: thread=%s error=%v", request.ThreadID, err)
	}
	completedAt := now
	completion := strings.TrimSpace(request.Completion)
	if completion == "" {
		completion = "discord response posted"
	}
	posted := request.Posted || strings.TrimSpace(request.Error) == ""
	if err := b.store.InsertAgentRun(ctx, newInteractionAgentRun(request, now, &completedAt, posted, completion)); err != nil {
		log.Printf("record discord interaction run failed: thread=%s error=%v", request.ThreadID, err)
	}
	b.appendDiscordInteractionThreadTraces(request, now, completedAt, posted, completion)
}

func newInteractionAgentThread(request interactionThreadRecord, now time.Time) store.AgentThread {
	payload := interactionThreadPayload(request.ToolGroups, request.BotMessageID, request.BotMessageText)
	payloadJSON, _ := json.Marshal(payload)
	return store.AgentThread{
		ThreadID:         request.ThreadID,
		Source:           "discord",
		ExternalID:       request.ExternalID,
		ParentExternalID: request.ParentID,
		RootExternalID:   request.RootID,
		Status:           "active",
		Title:            request.Title,
		CreatedAt:        now,
		UpdatedAt:        now,
		LastPayloadJSON:  string(payloadJSON),
	}
}

func newInteractionAgentEvent(request interactionThreadRecord, now time.Time) store.AgentThreadEvent {
	eventPayload, _ := json.Marshal(interactionEventPayload(request))
	return store.AgentThreadEvent{
		ThreadID:          request.ThreadID,
		EventType:         request.EventType,
		Actor:             request.Actor,
		ActorID:           request.ActorID,
		Message:           request.Content,
		ExternalMessageID: request.MessageID,
		PayloadJSON:       string(eventPayload),
		CreatedAt:         now,
	}
}

func newInteractionAgentRun(request interactionThreadRecord, startedAt time.Time, completedAt *time.Time, posted bool, completion string) store.AgentRun {
	return store.AgentRun{
		ThreadID:         request.ThreadID,
		SourceEventType:  request.EventType,
		StartedAt:        startedAt,
		CompletedAt:      completedAt,
		FinalResponse:    request.BotMessageText,
		Posted:           posted,
		Attribution:      request.Attribution,
		Error:            request.Error,
		CompletionReason: completion,
	}
}

func interactionEventPayload(request interactionThreadRecord) map[string]any {
	return map[string]any{
		"channel_id":     request.ParentID,
		"message_id":     request.MessageID,
		"root_id":        request.RootID,
		"bot_message_id": request.BotMessageID,
		"tool_groups":    request.ToolGroups,
	}
}

func (b *Bot) appendDiscordInteractionThreadTraces(request interactionThreadRecord, now, completedAt time.Time, posted bool, completion string) {
	b.appendDiscordTrace(request.ThreadID, map[string]any{
		"type":              "discord_interaction_thread",
		"thread_id":         request.ThreadID,
		"external_id":       request.ExternalID,
		"parent_channel_id": request.ParentID,
		"root_id":           request.RootID,
		"title":             request.Title,
		"event_type":        request.EventType,
		"tool_groups":       request.ToolGroups,
		"bot_message_id":    request.BotMessageID,
		"created_at":        now.Format(time.RFC3339Nano),
	})
	b.appendDiscordTrace(request.ThreadID, map[string]any{
		"type":                "discord_event",
		"thread_id":           request.ThreadID,
		"event_type":          request.EventType,
		"actor":               request.Actor,
		"actor_id":            request.ActorID,
		"message":             request.Content,
		"external_message_id": request.MessageID,
		"created_at":          now.Format(time.RFC3339Nano),
		"payload":             interactionEventPayload(request),
	})
	b.appendDiscordTrace(request.ThreadID, map[string]any{
		"type":              "discord_run",
		"thread_id":         request.ThreadID,
		"source_event_type": request.EventType,
		"started_at":        now.Format(time.RFC3339Nano),
		"completed_at":      completedAt.Format(time.RFC3339Nano),
		"final_response":    request.BotMessageText,
		"posted":            posted,
		"attribution":       request.Attribution,
		"error":             request.Error,
		"completion_reason": completion,
	})
}
