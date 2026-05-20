package discord

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"blitzcrank/internal/agent"
	"blitzcrank/internal/store"

	"github.com/bwmarrin/discordgo"
)

func (b *Bot) onMessageCreate(session *discordgo.Session, event *discordgo.MessageCreate) {
	if event.Author == nil || event.Author.Bot {
		return
	}

	content := strings.TrimSpace(event.Content)
	if content == "" {
		return
	}

	if b.handleReplyContinuation(session, event, content) {
		return
	}

	if event.ChannelID == b.cfg.AgentDiscordChannelID {
		go b.handleParentChannelMessage(session, event, content)
		return
	}

	if b.handleThreadMessage(session, event, content) {
		return
	}

	if b.mentionsBot(session, event.Message) {
		go b.replyToOffTrackMention(event)
		return
	}
}

func (b *Bot) replyToOffTrackMention(event *discordgo.MessageCreate) {
	reply := b.offTrackMentionReply()
	if _, err := b.sendMessageReference(context.Background(), event.ChannelID, event.ID, reply); err != nil {
		log.Printf("send discord off-track mention response failed: %v", err)
	}
}

func (b *Bot) offTrackMentionReply() string {
	channelID := strings.TrimSpace(b.cfg.AgentDiscordChannelID)
	if channelID == "" {
		return "Es wurde noch kein Channel für mich eingerichtet."
	}
	return fmt.Sprintf("Gespräche mit mir sollten in <#%s> bleiben.", channelID)
}

func (b *Bot) handleParentChannelMessage(session *discordgo.Session, event *discordgo.MessageCreate, content string) {
	if b.replyToParentModelRuntimeQuestion(session, event, content) {
		return
	}
	if b.mentionsBot(session, event.Message) && (isToolInventoryQuestion(content) || isAutomationScheduleQuestion(content)) {
		b.runDirectAgent(context.Background(), session, event, content)
		return
	}

	triage, mentioned, ok := b.triageParentChannelMessage(session, event, content)
	if !ok {
		return
	}

	if b.handleParentTriageTerminalAction(event, content, mentioned, triage) {
		return
	}

	if !b.parentTriageActionable(triage) {
		b.handleUnactionableParentTriage(event, content, mentioned, triage)
		return
	}
	b.runDirectAgent(context.Background(), session, event, content)
}

type discordSupportSurface string

const (
	discordSurfaceInline discordSupportSurface = "inline"
)

func parentSupportSurface(content string, mentioned bool, triage agent.DiscordTriageResult) discordSupportSurface {
	return discordSurfaceInline
}

func (b *Bot) replyToParentModelRuntimeQuestion(session *discordgo.Session, event *discordgo.MessageCreate, content string) bool {
	if !b.mentionsBot(session, event.Message) || !isModelRuntimeQuestion(content) {
		return false
	}
	startedAt := time.Now().UTC()
	authorID, isAdmin, audience := b.discordRequestSecurity(event)
	request := agent.Request{
		Source:   "discord_mention",
		Author:   discordAuthor(event.Author),
		AuthorID: authorID,
		IsAdmin:  isAdmin,
		Audience: audience,
		Content:  content,
	}
	reply := b.modelRuntimeReply(content, request)
	errText := ""
	if _, err := b.sendMessageReference(context.Background(), event.ChannelID, event.ID, reply); err != nil {
		log.Printf("send discord model info response failed: %v", err)
		errText = err.Error()
	}
	b.appendDiscordInteractionTrace(discordInteractionTraceRequest{Event: event, InteractionType: "model_runtime_reply", Content: content, Reply: reply, ErrorText: errText, StartedAt: startedAt, CompletedAt: time.Now().UTC(), Extra: map[string]any{"attribution": b.discordAttribution(request)}})
	return true
}

func (b *Bot) triageParentChannelMessage(session *discordgo.Session, event *discordgo.MessageCreate, content string) (agent.DiscordTriageResult, bool, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	startedAt := time.Now().UTC()
	mentioned := b.mentionsBot(session, event.Message)
	triage, err := b.agent.TriageDiscordMessage(ctx, agent.DiscordTriageRequest{
		Author:  discordAuthor(event.Author),
		Content: content,
		Mention: mentioned,
	})
	if err == nil {
		b.appendDiscordInteractionTrace(discordInteractionTraceRequest{Event: event, InteractionType: "triage_result", Content: content, Reply: triage.Reply, StartedAt: startedAt, CompletedAt: time.Now().UTC(), Extra: map[string]any{
			"mentioned":       mentioned,
			"triage_action":   triage.Action,
			"actionable":      triage.Actionable,
			"needs_agent_run": triage.NeedsAgentRun,
			"confidence":      triage.Confidence,
			"reason":          triage.Reason,
			"thread_title":    triage.ThreadTitle,
		}})
		return triage, mentioned, true
	}
	log.Printf("discord triage failed: message=%s error=%v", event.ID, err)
	if mentioned {
		reply := fallbackIntakeReply(content, "clarify")
		errText := err.Error()
		if _, sendErr := b.sendMessageReference(context.Background(), event.ChannelID, event.ID, reply); sendErr != nil {
			log.Printf("send discord intake fallback response failed: %v", sendErr)
			errText = errText + "; send: " + sendErr.Error()
		}
		b.appendDiscordInteractionTrace(discordInteractionTraceRequest{Event: event, InteractionType: "triage_fallback", Content: content, Reply: reply, ErrorText: errText, StartedAt: startedAt, CompletedAt: time.Now().UTC(), Extra: map[string]any{"mentioned": mentioned}})
	} else {
		b.appendDiscordInteractionTrace(discordInteractionTraceRequest{Event: event, InteractionType: "triage_error", Content: content, ErrorText: err.Error(), StartedAt: startedAt, CompletedAt: time.Now().UTC(), Extra: map[string]any{"mentioned": mentioned}})
	}
	return agent.DiscordTriageResult{}, mentioned, false
}

func (b *Bot) handleParentTriageTerminalAction(event *discordgo.MessageCreate, content string, mentioned bool, triage agent.DiscordTriageResult) bool {
	switch strings.TrimSpace(triage.Action) {
	case "direct_reply", "unsupported", "clarify":
		if mentioned {
			b.replyToParentTriage(event, content, triage.Action, triage.Reply)
		}
		return true
	case "support_request":
		return false
	default:
		log.Printf("discord triage ignored: message=%s confidence=%.2f reason=%q", event.ID, triage.Confidence, triage.Reason)
		return true
	}
}

func (b *Bot) parentTriageActionable(triage agent.DiscordTriageResult) bool {
	return triage.Actionable && triage.NeedsAgentRun && triage.Confidence >= b.cfg.DiscordTriageThreshold
}

func (b *Bot) handleUnactionableParentTriage(event *discordgo.MessageCreate, content string, mentioned bool, triage agent.DiscordTriageResult) {
	if mentioned {
		b.replyToParentTriage(event, content, "clarify", triage.Reply)
		return
	}
	log.Printf("discord triage ignored: message=%s confidence=%.2f reason=%q", event.ID, triage.Confidence, triage.Reason)
}

func (b *Bot) replyToParentTriage(event *discordgo.MessageCreate, content, action, reply string) {
	startedAt := time.Now().UTC()
	reply = strings.TrimSpace(reply)
	if reply == "" {
		reply = fallbackIntakeReply(content, action)
	}
	errText := ""
	message, err := b.sendMessageReference(context.Background(), event.ChannelID, event.ID, reply)
	if err != nil {
		log.Printf("send discord intake response failed: %v", err)
		errText = err.Error()
	} else if message != nil {
		action = strings.TrimSpace(action)
		if action == "" {
			action = "direct_reply"
		}
		b.recordDiscordInteractionThread(context.Background(), interactionThreadRecord{
			ThreadID:       discordThreadID(message.ID),
			ExternalID:     message.ID,
			ParentID:       event.ChannelID,
			RootID:         event.ID,
			Title:          threadTitle(content),
			Actor:          discordAuthor(event.Author),
			ActorID:        discordUserID(event.Author),
			MessageID:      event.ID,
			EventType:      "triage_" + action,
			Content:        content,
			BotMessageID:   message.ID,
			BotMessageText: reply,
			ToolGroups:     discordToolGroupsForContent(content),
			Attribution:    "discord:triage",
		})
	}
	b.appendDiscordInteractionTrace(discordInteractionTraceRequest{Event: event, InteractionType: "triage_" + strings.TrimSpace(action), Content: content, Reply: reply, ErrorText: errText, StartedAt: startedAt, CompletedAt: time.Now().UTC(), Extra: map[string]any{"triage_action": action}})
}

func (b *Bot) runDirectAgent(ctx context.Context, session *discordgo.Session, event *discordgo.MessageCreate, content string) {
	runCtx, cancel := context.WithTimeout(ctx, b.cfg.RunTimeout)
	defer cancel()
	startedAt := time.Now().UTC()
	seerrUserID, requestContext := b.seerrRequestContext(content, discordUserID(event.Author))
	groups := discordToolGroupsForContent(content)
	authorID, isAdmin, audience := b.discordRequestSecurity(event)

	request := agent.Request{
		Source:       b.directAgentSource(session, event),
		Author:       discordAuthor(event.Author),
		AuthorID:     authorID,
		IsAdmin:      isAdmin,
		Audience:     audience,
		Content:      content,
		Context:      requestContext,
		ToolGroups:   groups,
		ToolApproval: b.discordToolApproval(runCtx, event),
		SeerrUserID:  seerrUserID,
	}
	if isModelRuntimeQuestion(content) {
		reply := b.modelRuntimeReply(content, request)
		errText := ""
		if _, err := b.sendMessageReference(runCtx, event.ChannelID, event.ID, reply); err != nil {
			log.Printf("send discord model info response failed: %v", err)
			errText = err.Error()
		}
		b.appendDiscordInteractionTrace(discordInteractionTraceRequest{Event: event, InteractionType: "model_runtime_reply", Content: content, Reply: reply, ErrorText: errText, StartedAt: startedAt, CompletedAt: time.Now().UTC(), Extra: map[string]any{"attribution": b.discordAttribution(request)}})
		return
	}

	if err := session.ChannelTyping(event.ChannelID); err != nil {
		log.Printf("send typing indicator: %v", err)
	}
	progress := b.newDiscordProgressReporter(session, event.ChannelID, event.ID)
	request.Progress = progress.callback(runCtx)

	reply, err := b.agent.Respond(runCtx, request)
	errText := ""
	if err != nil {
		log.Printf("agent discord mention response failed: %v", err)
		errText = err.Error()
		reply = "I could not process that request. Check the bot logs for details."
	} else if reply, err = validateDiscordReply(reply); err != nil {
		log.Printf("agent discord mention response invalid: %v", err)
		errText = err.Error()
		reply = safeDiscordFailureReply(content)
	}
	message, sendErr := progress.finish(runCtx, reply)
	if sendErr != nil {
		log.Printf("send discord mention response failed: %v", sendErr)
		if errText != "" {
			errText += "; send: "
		}
		errText += sendErr.Error()
	} else if message != nil {
		b.recordDiscordInteractionThread(context.Background(), interactionThreadRecord{
			ThreadID:       discordThreadID(message.ID),
			ExternalID:     message.ID,
			ParentID:       event.ChannelID,
			RootID:         event.ID,
			Title:          threadTitle(content),
			Actor:          discordAuthor(event.Author),
			ActorID:        event.Author.ID,
			MessageID:      event.ID,
			EventType:      "direct_agent",
			Content:        content,
			BotMessageID:   message.ID,
			BotMessageText: reply,
			ToolGroups:     groups,
			Attribution:    b.discordAttribution(request),
		})
	}
	b.appendDiscordInteractionTrace(discordInteractionTraceRequest{Event: event, InteractionType: "direct_agent_reply", Content: content, Reply: reply, ErrorText: errText, StartedAt: startedAt, CompletedAt: time.Now().UTC(), Extra: map[string]any{"attribution": b.discordAttribution(request)}})
}

func (b *Bot) directAgentSource(session *discordgo.Session, event *discordgo.MessageCreate) string {
	if b.mentionsBot(session, event.Message) {
		return "discord_mention"
	}
	return "discord_channel"
}

func (b *Bot) modelRuntimeReply(content string, request agent.Request) string {
	model, effort := b.agent.RuntimeInfo(request)
	if strings.TrimSpace(effort) == "" {
		effort = "unspecified"
	}
	if looksGerman(content) {
		return fmt.Sprintf("Ich verwende gerade `%s` mit `reasoning_effort=%s`.", model, effort)
	}
	return fmt.Sprintf("I am currently using `%s` with `reasoning_effort=%s`.", model, effort)
}

func (b *Bot) handleThreadMessage(session *discordgo.Session, event *discordgo.MessageCreate, content string) bool {
	if b.handleAutomationThreadMessage(session, event, content) {
		return true
	}

	channel, err := b.discordChannel(session, event.ChannelID)
	if err != nil {
		log.Printf("load discord channel failed: channel=%s error=%v", event.ChannelID, err)
		return false
	}
	if channel == nil || !channel.IsThread() {
		return false
	}

	mentioned := b.mentionsBot(session, event.Message)
	loaded, ok, err := b.loadDiscordThread(context.Background(), event.ChannelID)
	if err != nil {
		log.Printf("load discord agent thread failed: thread=%s error=%v", event.ChannelID, err)
		return true
	}
	if !ok {
		loaded, ok, err = b.loadDiscordThreadByBotMessageID(context.Background(), event.ChannelID)
		if err != nil {
			log.Printf("load discord reply-thread by channel failed: thread=%s error=%v", event.ChannelID, err)
			return true
		}
	}
	if !ok {
		loaded, ok, err = b.loadDiscordThreadByReplyTarget(context.Background(), event)
		if err != nil {
			log.Printf("load discord reply-thread parent failed: thread=%s error=%v", event.ChannelID, err)
			return true
		}
	}
	if ok {
		if !mentioned && !replyContinuationAuthorAllowed(loaded, event) {
			log.Printf("ignored discord thread continuation from non-original author: thread=%s channel=%s author=%s original_author=%s", loaded.ThreadID, event.ChannelID, discordUserID(event.Author), originalThreadAuthorID(loaded))
			return true
		}
		if loaded.ExternalID != event.ChannelID {
			b.adoptDiscordReplyThread(context.Background(), session, channel, loaded)
		}
		go b.runInteractionAgent(context.Background(), session, loaded, event, content)
		return true
	}
	if !ok && !mentioned {
		return true
	}
	if !ok {
		if channel.ParentID != b.cfg.AgentDiscordChannelID {
			return false
		}
		now := time.Now().UTC()
		loaded = store.AgentThread{
			ThreadID:         discordThreadID(event.ChannelID),
			Source:           "discord",
			ExternalID:       event.ChannelID,
			ParentExternalID: channel.ParentID,
			Status:           "active",
			Title:            channel.Name,
			CreatedAt:        now,
			UpdatedAt:        now,
		}
		if b.store != nil {
			if err := b.store.UpsertAgentThread(context.Background(), loaded); err != nil {
				log.Printf("adopt discord thread failed: thread=%s error=%v", event.ChannelID, err)
			}
		}
		b.appendDiscordTrace(loaded.ThreadID, map[string]any{
			"type":              "discord_thread",
			"thread_id":         loaded.ThreadID,
			"discord_thread_id": event.ChannelID,
			"parent_channel_id": channel.ParentID,
			"title":             channel.Name,
			"created_at":        now.Format(time.RFC3339Nano),
			"adopted":           true,
		})
	}

	if err := b.recordDiscordEvent(context.Background(), loaded.ThreadID, event, "message", content); err != nil {
		log.Printf("record discord thread event failed: thread=%s error=%v", event.ChannelID, err)
	}
	b.runThreadAgent(context.Background(), session, event.ChannelID, event, content, "message")
	return true
}
