package discord

import (
	"context"
	"encoding/json"
	"log"
	"strings"
	"time"

	"blitzcrank/internal/store"
)

func (b *Bot) updateDiscordThreadBotMessage(ctx context.Context, thread store.AgentThread, botMessageID, reply string) {
	if b.store == nil || strings.TrimSpace(botMessageID) == "" {
		return
	}
	if loaded, ok, err := b.store.LoadAgentThread(ctx, thread.ThreadID); err != nil {
		log.Printf("load discord thread for bot message update failed: thread=%s error=%v", thread.ThreadID, err)
	} else if ok {
		thread = loaded
	}
	payload := map[string]any{}
	if strings.TrimSpace(thread.LastPayloadJSON) != "" {
		_ = json.Unmarshal([]byte(thread.LastPayloadJSON), &payload)
	}
	payload["latest_bot_message_id"] = botMessageID
	payload["latest_bot_reply"] = reply
	payload["bot_message_ids"] = appendUniqueStringPayload(payload["bot_message_ids"], botMessageID)
	payloadJSON, _ := json.Marshal(payload)
	thread.LastPayloadJSON = string(payloadJSON)
	thread.UpdatedAt = time.Now().UTC()
	if err := b.store.UpsertAgentThread(ctx, thread); err != nil {
		log.Printf("update discord thread bot message failed: thread=%s error=%v", thread.ThreadID, err)
	}
}

func appendUniqueStringPayload(value any, next string) []string {
	next = strings.TrimSpace(next)
	var values []string
	switch typed := value.(type) {
	case []string:
		values = append(values, typed...)
	case []any:
		for _, item := range typed {
			if text, ok := item.(string); ok {
				values = append(values, text)
			}
		}
	}
	if next == "" {
		return values
	}
	for _, value := range values {
		if strings.TrimSpace(value) == next {
			return values
		}
	}
	return append(values, next)
}

func interactionThreadPayload(groups []string, botMessageID, reply string) map[string]any {
	messageIDs := appendUniqueStringPayload(nil, botMessageID)
	return map[string]any{
		"tool_groups":           groups,
		"bot_message_id":        botMessageID,
		"bot_reply":             reply,
		"latest_bot_message_id": botMessageID,
		"latest_bot_reply":      reply,
		"bot_message_ids":       messageIDs,
	}
}

func threadToolGroups(thread store.AgentThread) []string {
	if strings.TrimSpace(thread.LastPayloadJSON) == "" {
		return nil
	}
	var payload struct {
		ToolGroups []string `json:"tool_groups"`
	}
	_ = json.Unmarshal([]byte(thread.LastPayloadJSON), &payload)
	return payload.ToolGroups
}
