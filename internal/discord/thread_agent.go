package discord

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"blitzcrank/internal/agent"
	"blitzcrank/internal/store"

	"github.com/bwmarrin/discordgo"
)

type interactionThreadRecord struct {
	ThreadID       string
	ExternalID     string
	ParentID       string
	RootID         string
	Title          string
	Actor          string
	ActorID        string
	MessageID      string
	EventType      string
	Content        string
	ToolGroups     []string
	BotMessageID   string
	BotMessageText string
	Attribution    string
}

func (b *Bot) runThreadAgent(ctx context.Context, session *discordgo.Session, discordThreadID string, event *discordgo.MessageCreate, content, eventType string) {
	lock := b.threadLock(discordThreadID)
	lock.Lock()
	defer lock.Unlock()

	runCtx, cancel := context.WithTimeout(ctx, b.cfg.RunTimeout)
	defer cancel()

	if err := session.ChannelTyping(discordThreadID); err != nil {
		log.Printf("send typing indicator: %v", err)
	}

	thread, ok := b.threadContext(runCtx, discordThreadID)
	if !ok {
		return
	}
	groups := threadToolGroups(thread)
	seerrUserID, requestContext := b.seerrRequestContext(content, discordUserID(event.Author))

	start := time.Now().UTC()
	request := agent.Request{
		Source:       "discord_thread",
		Author:       discordAuthor(event.Author),
		Content:      b.discordPrompt(thread, content),
		Context:      requestContext,
		ToolGroups:   groups,
		ToolApproval: b.discordToolApproval(runCtx, event),
		SeerrUserID:  seerrUserID,
	}
	record := b.newDiscordRunRecord(thread.ThreadID, eventType, start, request)
	reply, err := b.agent.Respond(runCtx, request)
	if err != nil {
		log.Printf("agent discord response failed: thread=%s error=%v", discordThreadID, err)
		fallback := "I could not process that request. Check the bot logs for details."
		record.FinalResponse = fallback
		if sendErr := b.sendMessage(context.Background(), discordThreadID, fallback); sendErr != nil {
			err = fmt.Errorf("%w; fallback send: %w", err, sendErr)
		} else {
			record.Posted = true
		}
		b.recordFailedDiscordRun(record, "agent run failed", err)
		return
	}

	reply, err = validateDiscordReply(reply)
	if err != nil {
		log.Printf("agent discord response invalid: thread=%s error=%v", discordThreadID, err)
		fallback := safeDiscordFailureReply(content)
		record.FinalResponse = fallback
		if sendErr := b.sendMessage(context.Background(), discordThreadID, fallback); sendErr != nil {
			err = fmt.Errorf("%w; fallback send: %w", err, sendErr)
		} else {
			record.Posted = true
		}
		b.recordFailedDiscordRun(record, "agent response failed validation", err)
		return
	}

	record.FinalResponse = reply
	message, err := b.sendMessageReference(runCtx, discordThreadID, "", reply)
	if err != nil {
		b.recordFailedDiscordRun(record, "discord response failed", err)
		log.Printf("send discord response failed: thread=%s error=%v", discordThreadID, err)
		return
	}
	record.Posted = message != nil
	completedAt := time.Now().UTC()
	record.CompletedAt = &completedAt
	record.CompletionReason = "discord response posted"
	record.Summary = b.summarizeDiscordThread(discordThreadID, thread.Summary, content, reply)
	b.persistDiscordRun(thread.ThreadID, record)
	if message != nil {
		b.updateDiscordThreadBotMessage(context.Background(), thread, message.ID, reply)
	}
}

func (b *Bot) handleReplyContinuation(session *discordgo.Session, event *discordgo.MessageCreate, content string) bool {
	targetID := messageReplyTargetID(event.Message)
	if targetID == "" || b.store == nil {
		return false
	}
	thread, ok, err := b.store.LoadAgentThreadByBotMessageID(context.Background(), "discord", targetID)
	if err != nil {
		log.Printf("load discord reply continuation failed: target=%s error=%v", targetID, err)
		return false
	}
	if !ok {
		return false
	}
	if !replyContinuationAuthorAllowed(thread, event) {
		log.Printf("ignored discord reply continuation from non-original author: thread=%s target=%s author=%s original_author=%s", thread.ThreadID, targetID, discordUserID(event.Author), originalThreadAuthorID(thread))
		return false
	}
	go b.runInteractionAgent(context.Background(), session, thread, event, content)
	return true
}

func replyContinuationAuthorAllowed(thread store.AgentThread, event *discordgo.MessageCreate) bool {
	if event == nil {
		return false
	}
	authorID := discordUserID(event.Author)
	originalAuthorID := originalThreadAuthorID(thread)
	return authorID != "" && originalAuthorID != "" && authorID == originalAuthorID
}

func originalThreadAuthorID(thread store.AgentThread) string {
	for _, event := range thread.Events {
		if event.EventType == "feedback" {
			continue
		}
		if actorID := strings.TrimSpace(event.ActorID); actorID != "" {
			return actorID
		}
	}
	return ""
}

func (b *Bot) runInteractionAgent(ctx context.Context, session *discordgo.Session, thread store.AgentThread, event *discordgo.MessageCreate, content string) {
	lock := b.threadLock(thread.ThreadID)
	lock.Lock()
	defer lock.Unlock()

	runCtx, cancel := context.WithTimeout(ctx, b.cfg.RunTimeout)
	defer cancel()

	if err := b.recordDiscordEvent(runCtx, thread.ThreadID, event, "reply", content); err != nil {
		log.Printf("record discord reply continuation failed: thread=%s error=%v", thread.ThreadID, err)
	}
	if b.store != nil {
		if loaded, ok, err := b.store.LoadAgentThread(runCtx, thread.ThreadID); err == nil && ok {
			thread = loaded
		}
	}
	if err := session.ChannelTyping(event.ChannelID); err != nil {
		log.Printf("send typing indicator: %v", err)
	}

	groups := threadToolGroups(thread)
	seerrUserID, requestContext := b.seerrRequestContext(content, discordUserID(event.Author))
	request := agent.Request{
		Source:       "discord_reply",
		Author:       discordAuthor(event.Author),
		Content:      b.discordPrompt(thread, content),
		Context:      requestContext,
		ToolGroups:   groups,
		ToolApproval: b.discordToolApproval(runCtx, event),
		SeerrUserID:  seerrUserID,
	}
	start := time.Now().UTC()
	record := b.newDiscordRunRecord(thread.ThreadID, "reply", start, request)
	reply, err := b.agent.Respond(runCtx, request)
	if err != nil {
		log.Printf("agent discord reply continuation failed: thread=%s error=%v", thread.ThreadID, err)
		reply = "I could not process that request. Check the bot logs for details."
		record.Error = err.Error()
		record.CompletionReason = "agent run failed"
	} else if reply, err = validateDiscordReply(reply); err != nil {
		log.Printf("agent discord reply continuation invalid: thread=%s error=%v", thread.ThreadID, err)
		reply = safeDiscordFailureReply(content)
		record.Error = err.Error()
		record.CompletionReason = "agent response failed validation"
	} else {
		record.CompletionReason = "discord response posted"
	}

	message, sendErr := b.sendMessageReference(runCtx, event.ChannelID, event.ID, reply)
	if sendErr != nil {
		record.Error = strings.TrimSpace(record.Error + "; send: " + sendErr.Error())
		record.CompletionReason = "discord response failed"
		b.recordFailedDiscordRun(record, record.CompletionReason, sendErr)
		return
	}
	record.FinalResponse = reply
	record.Posted = message != nil
	record.Summary = b.summarizeDiscordThread(thread.ThreadID, thread.Summary, content, reply)
	b.persistDiscordRun(thread.ThreadID, record)
	if message != nil {
		b.updateInteractionThreadBotMessage(context.Background(), thread, message.ID, reply, groups)
	}
}

func (b *Bot) recordDiscordInteractionThread(ctx context.Context, request interactionThreadRecord) {
	if b.store == nil || strings.TrimSpace(request.ThreadID) == "" {
		return
	}
	now := time.Now().UTC()
	payload := interactionThreadPayload(request.ToolGroups, request.BotMessageID, request.BotMessageText)
	payloadJSON, _ := json.Marshal(payload)
	thread := store.AgentThread{
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
	if err := b.store.UpsertAgentThread(ctx, thread); err != nil {
		log.Printf("record discord interaction thread failed: thread=%s error=%v", request.ThreadID, err)
		return
	}
	eventPayload, _ := json.Marshal(map[string]any{
		"channel_id":     request.ParentID,
		"message_id":     request.MessageID,
		"root_id":        request.RootID,
		"bot_message_id": request.BotMessageID,
		"tool_groups":    request.ToolGroups,
	})
	if err := b.store.InsertAgentThreadEvent(ctx, store.AgentThreadEvent{
		ThreadID:          request.ThreadID,
		EventType:         request.EventType,
		Actor:             request.Actor,
		ActorID:           request.ActorID,
		Message:           request.Content,
		ExternalMessageID: request.MessageID,
		PayloadJSON:       string(eventPayload),
		CreatedAt:         now,
	}); err != nil {
		log.Printf("record discord interaction event failed: thread=%s error=%v", request.ThreadID, err)
	}
	completedAt := now
	if err := b.store.InsertAgentRun(ctx, store.AgentRun{
		ThreadID:         request.ThreadID,
		SourceEventType:  request.EventType,
		StartedAt:        now,
		CompletedAt:      &completedAt,
		FinalResponse:    request.BotMessageText,
		Posted:           true,
		Attribution:      request.Attribution,
		CompletionReason: "discord response posted",
	}); err != nil {
		log.Printf("record discord interaction run failed: thread=%s error=%v", request.ThreadID, err)
	}
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
}

func (b *Bot) updateInteractionThreadBotMessage(ctx context.Context, thread store.AgentThread, botMessageID, reply string, groups []string) {
	if b.store == nil || strings.TrimSpace(botMessageID) == "" {
		return
	}
	if loaded, ok, err := b.store.LoadAgentThread(ctx, thread.ThreadID); err != nil {
		log.Printf("load discord interaction thread for bot message update failed: thread=%s error=%v", thread.ThreadID, err)
	} else if ok {
		thread = loaded
	}
	payload := map[string]any{}
	if strings.TrimSpace(thread.LastPayloadJSON) != "" {
		_ = json.Unmarshal([]byte(thread.LastPayloadJSON), &payload)
	}
	payload["tool_groups"] = groups
	payload["bot_message_id"] = botMessageID
	payload["bot_reply"] = reply
	payload["latest_bot_message_id"] = botMessageID
	payload["latest_bot_reply"] = reply
	payload["bot_message_ids"] = appendUniqueStringPayload(payload["bot_message_ids"], botMessageID)
	payloadJSON, _ := json.Marshal(payload)
	thread.ExternalID = botMessageID
	thread.LastPayloadJSON = string(payloadJSON)
	thread.UpdatedAt = time.Now().UTC()
	if err := b.store.UpsertAgentThread(ctx, thread); err != nil {
		log.Printf("update discord interaction thread failed: thread=%s error=%v", thread.ThreadID, err)
	}
}

func (b *Bot) threadContext(ctx context.Context, discordThreadID string) (store.AgentThread, bool) {
	thread, ok, err := b.loadDiscordThread(ctx, discordThreadID)
	if err != nil {
		log.Printf("load discord context failed: thread=%s error=%v", discordThreadID, err)
		return store.AgentThread{}, false
	}
	if !ok {
		log.Printf("discord agent thread missing: thread=%s", discordThreadID)
	}
	return thread, ok
}

func (b *Bot) newDiscordRunRecord(threadID, eventType string, startedAt time.Time, request agent.Request) store.AgentRun {
	return store.AgentRun{
		ThreadID:        threadID,
		SourceEventType: eventType,
		StartedAt:       startedAt,
		Attribution:     b.discordAttribution(request),
	}
}

func (b *Bot) recordFailedDiscordRun(record store.AgentRun, reason string, err error) {
	if record.CompletedAt == nil {
		completedAt := time.Now().UTC()
		record.CompletedAt = &completedAt
	}
	record.Error = err.Error()
	record.CompletionReason = reason
	if b.store != nil {
		_ = b.store.InsertAgentRun(context.Background(), record)
	}
	b.appendDiscordTrace(record.ThreadID, map[string]any{
		"type":              "discord_run",
		"thread_id":         record.ThreadID,
		"source_event_type": record.SourceEventType,
		"started_at":        record.StartedAt.Format(time.RFC3339Nano),
		"completed_at":      formatOptionalTime(record.CompletedAt),
		"final_response":    record.FinalResponse,
		"posted":            record.Posted,
		"attribution":       record.Attribution,
		"error":             record.Error,
		"completion_reason": record.CompletionReason,
	})
}

func (b *Bot) summarizeDiscordThread(threadID, priorSummary, content, reply string) string {
	summaryCtx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	updated, err := b.agent.SummarizeDiscordThread(summaryCtx, priorSummary, content, reply)
	if err != nil {
		log.Printf("summarize discord thread failed: thread=%s error=%v", threadID, err)
		return priorSummary
	}
	return updated
}

func (b *Bot) persistDiscordRun(threadID string, record store.AgentRun) {
	if record.CompletedAt == nil {
		completedAt := time.Now().UTC()
		record.CompletedAt = &completedAt
	}
	if b.store != nil {
		if err := b.store.InsertAgentRun(context.Background(), record); err != nil {
			log.Printf("insert discord agent run failed: thread=%s error=%v", threadID, err)
		}
		if err := b.store.UpdateAgentThreadSummary(context.Background(), threadID, record.Summary, time.Now().UTC()); err != nil {
			log.Printf("update discord summary failed: thread=%s error=%v", threadID, err)
		}
	}
	b.appendDiscordTrace(threadID, map[string]any{
		"type":              "discord_run",
		"thread_id":         threadID,
		"source_event_type": record.SourceEventType,
		"started_at":        record.StartedAt.Format(time.RFC3339Nano),
		"completed_at":      formatOptionalTime(record.CompletedAt),
		"final_response":    record.FinalResponse,
		"posted":            record.Posted,
		"attribution":       record.Attribution,
		"error":             record.Error,
		"completion_reason": record.CompletionReason,
		"summary":           record.Summary,
	})
}
