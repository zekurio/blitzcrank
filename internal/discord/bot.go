package discord

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"blitzcrank/internal/agent"
	"blitzcrank/internal/config"
	"blitzcrank/internal/store"

	"github.com/bwmarrin/discordgo"
)

type Bot struct {
	cfg     config.Config
	agent   *agent.Agent
	store   *store.Store
	session *discordgo.Session
	locks   sync.Map
	botID   string
}

func NewBot(cfg config.Config, assistant *agent.Agent, state *store.Store) (*Bot, error) {
	session, err := discordgo.New("Bot " + cfg.DiscordToken)
	if err != nil {
		return nil, err
	}
	session.Identify.Intents = discordgo.IntentsGuildMessages | discordgo.IntentsMessageContent

	bot := &Bot{cfg: cfg, agent: assistant, store: state, session: session}
	session.AddHandler(bot.onMessageCreate)
	return bot, nil
}

func (b *Bot) Start() error {
	if err := b.session.Open(); err != nil {
		return err
	}
	if b.session.State != nil && b.session.State.User != nil {
		b.botID = b.session.State.User.ID
		return nil
	}
	user, err := b.session.User("@me")
	if err != nil {
		log.Printf("load discord bot user failed: %v", err)
		return nil
	}
	b.botID = user.ID
	return nil
}

func (b *Bot) Close() {
	b.session.Close()
}

func (b *Bot) SendMessage(ctx context.Context, content string) error {
	return b.sendMessage(ctx, b.cfg.AgentDiscordChannelID, content)
}

func (b *Bot) SendAutomationReport(ctx context.Context, automationName, content string) error {
	threadID, err := b.automationThreadID(ctx, automationName)
	if err != nil {
		return err
	}
	if err := b.lockAutomationThread(threadID); err != nil {
		threadID, err = b.createAutomationThread(ctx, automationName)
		if err != nil {
			return err
		}
	}
	if err := b.sendMessage(ctx, threadID, content); err != nil {
		threadID, createErr := b.createAutomationThread(ctx, automationName)
		if createErr != nil {
			return err
		}
		if err := b.lockAutomationThread(threadID); err != nil {
			return err
		}
		if err := b.sendMessage(ctx, threadID, content); err != nil {
			return err
		}
	}
	b.recordAutomationReport(ctx, automationName, content)
	return nil
}

func (b *Bot) automationThreadID(ctx context.Context, automationName string) (string, error) {
	if b.store != nil {
		thread, ok, err := b.store.LoadAgentThreadByExternalID(ctx, "discord_automation", automationName)
		if err != nil {
			return "", err
		}
		if ok && thread.RootExternalID != "" {
			return thread.RootExternalID, nil
		}
	}
	return b.createAutomationThread(ctx, automationName)
}

func (b *Bot) createAutomationThread(ctx context.Context, automationName string) (string, error) {
	thread, err := b.session.ThreadStart(
		b.cfg.AgentDiscordChannelID,
		automationThreadTitle(automationName),
		discordgo.ChannelTypeGuildPublicThread,
		b.cfg.DiscordThreadArchiveMinutes,
	)
	if err != nil {
		return "", err
	}
	if err := b.lockAutomationThread(thread.ID); err != nil {
		return "", err
	}
	if b.store != nil {
		now := time.Now().UTC()
		record := store.AgentThread{
			ThreadID:         "discord_automation:" + automationName,
			Source:           "discord_automation",
			ExternalID:       automationName,
			ParentExternalID: b.cfg.AgentDiscordChannelID,
			RootExternalID:   thread.ID,
			Status:           "active",
			Title:            automationThreadTitle(automationName),
			CreatedAt:        now,
			UpdatedAt:        now,
		}
		if err := b.store.UpsertAgentThread(ctx, record); err != nil {
			log.Printf("record automation thread failed: automation=%s error=%v", automationName, err)
		}
	}
	return thread.ID, nil
}

func (b *Bot) lockAutomationThread(threadID string) error {
	archived := false
	locked := true
	_, err := b.session.ChannelEdit(threadID, &discordgo.ChannelEdit{
		Archived: &archived,
		Locked:   &locked,
	})
	return err
}

func (b *Bot) isAutomationThread(ctx context.Context, channelID string) bool {
	if b.store == nil {
		return false
	}
	_, ok, err := b.store.LoadAgentThreadByRootExternalID(ctx, "discord_automation", channelID)
	if err != nil {
		log.Printf("load automation thread failed: thread=%s error=%v", channelID, err)
		return false
	}
	return ok
}

func (b *Bot) recordAutomationReport(ctx context.Context, automationName, content string) {
	if b.store == nil {
		return
	}
	if err := b.store.InsertAgentThreadEvent(ctx, store.AgentThreadEvent{
		ThreadID:  "discord_automation:" + automationName,
		EventType: "automation_report",
		Actor:     b.cfg.BotPublicName,
		Message:   content,
		CreatedAt: time.Now().UTC(),
	}); err != nil {
		log.Printf("record automation report failed: automation=%s error=%v", automationName, err)
	}
}

func automationThreadTitle(automationName string) string {
	title := strings.ReplaceAll(strings.TrimSpace(automationName), "-", " ")
	title = strings.Join(strings.Fields(title), " ")
	if title == "" {
		return "automation"
	}
	return "automation: " + title
}

func (b *Bot) sendMessage(ctx context.Context, channelID, content string) error {
	return b.sendMessageReference(ctx, channelID, "", content)
}

func (b *Bot) sendMessageReference(ctx context.Context, channelID, replyToMessageID, content string) error {
	if strings.TrimSpace(content) == "" {
		return nil
	}
	chunks := splitDiscordMessage(content)
	for index, chunk := range chunks {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
			message := &discordgo.MessageSend{
				Content:         chunk,
				AllowedMentions: &discordgo.MessageAllowedMentions{},
			}
			if index == 0 && replyToMessageID != "" {
				message.Reference = &discordgo.MessageReference{
					MessageID: replyToMessageID,
					ChannelID: channelID,
				}
			}
			if _, err := b.session.ChannelMessageSendComplex(channelID, message); err != nil {
				return err
			}
		}
	}
	return nil
}

func (b *Bot) onMessageCreate(session *discordgo.Session, event *discordgo.MessageCreate) {
	if event.Author == nil || event.Author.Bot {
		return
	}

	content := strings.TrimSpace(event.Content)
	if content == "" {
		return
	}

	if event.ChannelID == b.cfg.AgentDiscordChannelID {
		go b.handleParentChannelMessage(session, event, content)
		return
	}

	go b.handleThreadMessage(session, event, content)
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
	if mentioned {
		b.runDirectAgent(context.Background(), session, event, content)
		return
	}
	if isOneOffDiscordQuestion(content, triage) {
		b.runDirectAgent(context.Background(), session, event, content)
		return
	}

	title := strings.TrimSpace(triage.ThreadTitle)
	if title == "" {
		title = titleFromContent(content)
	}
	thread, err := session.MessageThreadStart(event.ChannelID, event.ID, threadTitle(title), b.cfg.DiscordThreadArchiveMinutes)
	if err != nil {
		log.Printf("create discord thread failed: channel=%s message=%s error=%v", event.ChannelID, event.ID, err)
		return
	}

	if err := b.recordDiscordThread(context.Background(), recordDiscordThreadRequest{
		ThreadID:      thread.ID,
		ParentID:      event.ChannelID,
		RootMessageID: event.ID,
		Title:         thread.Name,
		Event:         event,
		EventType:     "root_message",
		Content:       content,
	}); err != nil {
		log.Printf("record discord root thread failed: thread=%s error=%v", thread.ID, err)
	}
	b.runThreadAgent(context.Background(), session, thread.ID, event, content, "root_message")
}

func (b *Bot) replyToParentModelRuntimeQuestion(session *discordgo.Session, event *discordgo.MessageCreate, content string) bool {
	if !b.mentionsBot(session, event.Message) || !isModelRuntimeQuestion(content) {
		return false
	}
	request := agent.Request{
		Source:  "discord_mention",
		Author:  discordAuthor(event.Author),
		Content: content,
	}
	if err := b.sendMessageReference(context.Background(), event.ChannelID, event.ID, b.modelRuntimeReply(content, request)); err != nil {
		log.Printf("send discord model info response failed: %v", err)
	}
	return true
}

func (b *Bot) triageParentChannelMessage(session *discordgo.Session, event *discordgo.MessageCreate, content string) (agent.DiscordTriageResult, bool, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	mentioned := b.mentionsBot(session, event.Message)
	triage, err := b.agent.TriageDiscordMessage(ctx, agent.DiscordTriageRequest{
		Author:  discordAuthor(event.Author),
		Content: content,
		Mention: mentioned,
	})
	if err == nil {
		return triage, mentioned, true
	}
	log.Printf("discord triage failed: message=%s error=%v", event.ID, err)
	if mentioned {
		if err := b.sendMessageReference(context.Background(), event.ChannelID, event.ID, fallbackIntakeReply(content, "clarify")); err != nil {
			log.Printf("send discord intake fallback response failed: %v", err)
		}
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
	reply = strings.TrimSpace(reply)
	if reply == "" {
		reply = fallbackIntakeReply(content, action)
	}
	if err := b.sendMessageReference(context.Background(), event.ChannelID, event.ID, reply); err != nil {
		log.Printf("send discord intake response failed: %v", err)
	}
}

func (b *Bot) runDirectAgent(ctx context.Context, session *discordgo.Session, event *discordgo.MessageCreate, content string) {
	runCtx, cancel := context.WithTimeout(ctx, b.cfg.RunTimeout)
	defer cancel()

	request := agent.Request{
		Source:  "discord_mention",
		Author:  discordAuthor(event.Author),
		Content: content,
	}
	if isModelRuntimeQuestion(content) {
		if err := b.sendMessageReference(runCtx, event.ChannelID, event.ID, b.modelRuntimeReply(content, request)); err != nil {
			log.Printf("send discord model info response failed: %v", err)
		}
		return
	}

	if err := session.ChannelTyping(event.ChannelID); err != nil {
		log.Printf("send typing indicator: %v", err)
	}

	reply, err := b.agent.Respond(runCtx, request)
	if err != nil {
		log.Printf("agent discord mention response failed: %v", err)
		reply = "I could not process that request. Check the bot logs for details."
	} else if reply, err = validateDiscordReply(reply); err != nil {
		log.Printf("agent discord mention response invalid: %v", err)
		reply = safeDiscordFailureReply(content)
	}
	if err := b.sendMessageReference(runCtx, event.ChannelID, event.ID, reply); err != nil {
		log.Printf("send discord mention response failed: %v", err)
	}
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

func (b *Bot) handleThreadMessage(session *discordgo.Session, event *discordgo.MessageCreate, content string) {
	if b.isAutomationThread(context.Background(), event.ChannelID) {
		log.Printf("ignored user message in automation thread: thread=%s message=%s", event.ChannelID, event.ID)
		return
	}

	channel, err := b.discordChannel(session, event.ChannelID)
	if err != nil {
		log.Printf("load discord channel failed: channel=%s error=%v", event.ChannelID, err)
		return
	}
	if channel == nil || !channel.IsThread() || channel.ParentID != b.cfg.AgentDiscordChannelID {
		return
	}

	mentioned := b.mentionsBot(session, event.Message)
	loaded, ok, err := b.loadDiscordThread(context.Background(), event.ChannelID)
	if err != nil {
		log.Printf("load discord agent thread failed: thread=%s error=%v", event.ChannelID, err)
		return
	}
	if !ok && !mentioned {
		return
	}
	if !ok {
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
	}

	if err := b.recordDiscordEvent(context.Background(), loaded.ThreadID, event, "message", content); err != nil {
		log.Printf("record discord thread event failed: thread=%s error=%v", event.ChannelID, err)
	}
	b.runThreadAgent(context.Background(), session, event.ChannelID, event, content, "message")
}
