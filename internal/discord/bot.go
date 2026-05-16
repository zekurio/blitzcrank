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
