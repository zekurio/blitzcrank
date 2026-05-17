package discord

import (
	"context"
	"log"
	"strings"
	"sync"
	"time"

	"blitzcrank/internal/agent"
	"blitzcrank/internal/config"
	"blitzcrank/internal/discord/commands"
	"blitzcrank/internal/store"

	"github.com/bwmarrin/discordgo"
)

type Bot struct {
	cfg       config.Config
	agent     *agent.Agent
	runtime   RuntimeManager
	store     *store.Store
	session   *discordgo.Session
	api       discordSessionAPI
	locks     sync.Map
	approvals sync.Map
	botID     string
}

type discordSessionAPI interface {
	Open() error
	User(string, ...discordgo.RequestOption) (*discordgo.User, error)
	ApplicationCommands(string, string, ...discordgo.RequestOption) ([]*discordgo.ApplicationCommand, error)
	ApplicationCommandEdit(string, string, string, *discordgo.ApplicationCommand, ...discordgo.RequestOption) (*discordgo.ApplicationCommand, error)
	ApplicationCommandCreate(string, string, *discordgo.ApplicationCommand, ...discordgo.RequestOption) (*discordgo.ApplicationCommand, error)
}

type RuntimeManager interface {
	ReloadSkills() error
	ReloadAutomations() error
	ConfigGet(string) (string, error)
	ConfigSet(string, string) error
	Restart()
	RunAutomation(context.Context, string) error
	AutomationNames() []string
	AutomationStatus(time.Time) string
}

func NewBot(cfg config.Config, assistant *agent.Agent, state *store.Store) (*Bot, error) {
	session, err := discordgo.New("Bot " + cfg.DiscordToken)
	if err != nil {
		return nil, err
	}
	session.Identify.Intents = discordgo.IntentsGuildMessages | discordgo.IntentsGuildMessageReactions | discordgo.IntentsMessageContent

	bot := &Bot{cfg: cfg, agent: assistant, store: state, session: session, api: session}
	session.AddHandler(bot.onMessageCreate)
	session.AddHandler(bot.onMessageReactionAdd)
	session.AddHandler(bot.onInteractionCreate)
	return bot, nil
}

func (b *Bot) SetRuntimeManager(runtime RuntimeManager) {
	b.runtime = runtime
}

func (b *Bot) Start() error {
	api := b.discordAPI()
	if err := api.Open(); err != nil {
		return err
	}
	if b.session.State != nil && b.session.State.User != nil {
		b.botID = b.session.State.User.ID
		return b.registerRuntimeCommands()
	}
	user, err := api.User("@me")
	if err != nil {
		return err
	}
	b.botID = user.ID
	return b.registerRuntimeCommands()
}

func (b *Bot) Close() {
	b.session.Close()
}

func (b *Bot) registerRuntimeCommands() error {
	if strings.TrimSpace(b.botID) == "" {
		return nil
	}
	api := b.discordAPI()
	registeredCommands, err := api.ApplicationCommands(b.botID, b.cfg.DiscordGuildID)
	if err != nil {
		return err
	}
	existing := map[string]string{}
	for _, command := range registeredCommands {
		existing[command.Name] = command.ID
	}
	for _, command := range commands.ApplicationCommands() {
		if id := existing[command.Name]; id != "" {
			if _, err := api.ApplicationCommandEdit(b.botID, b.cfg.DiscordGuildID, id, command); err != nil {
				return err
			}
			continue
		}
		if _, err := api.ApplicationCommandCreate(b.botID, b.cfg.DiscordGuildID, command); err != nil {
			return err
		}
	}
	return nil
}

func (b *Bot) discordAPI() discordSessionAPI {
	if b.api != nil {
		return b.api
	}
	return b.session
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
		b.appendAutomationTrace(automationName, map[string]any{
			"type":               "discord_automation_thread",
			"thread_id":          record.ThreadID,
			"automation":         automationName,
			"discord_thread_id":  thread.ID,
			"parent_channel_id":  b.cfg.AgentDiscordChannelID,
			"title":              record.Title,
			"created_at":         now.Format(time.RFC3339Nano),
			"sqlite_state_usage": "reuses Discord automation report thread and ignores user messages inside it",
		})
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
	b.appendAutomationTrace(automationName, map[string]any{
		"type":       "discord_automation_report",
		"automation": automationName,
		"actor":      b.cfg.BotPublicName,
		"message":    content,
		"at":         time.Now().UTC().Format(time.RFC3339Nano),
	})
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
	_, err := b.sendMessageReference(ctx, channelID, "", content)
	return err
}

func (b *Bot) sendMessageReference(ctx context.Context, channelID, replyToMessageID, content string) (*discordgo.Message, error) {
	return b.sendMessageReferenceAllowedMentions(ctx, channelID, replyToMessageID, content, &discordgo.MessageAllowedMentions{})
}

func (b *Bot) sendMessageReferenceAllowedMentions(ctx context.Context, channelID, replyToMessageID, content string, allowedMentions *discordgo.MessageAllowedMentions) (*discordgo.Message, error) {
	if strings.TrimSpace(content) == "" {
		return nil, nil
	}
	chunks := splitDiscordMessage(content)
	var first *discordgo.Message
	for index, chunk := range chunks {
		select {
		case <-ctx.Done():
			return first, ctx.Err()
		default:
			message := &discordgo.MessageSend{
				Content:         chunk,
				AllowedMentions: allowedMentions,
			}
			if index == 0 && replyToMessageID != "" {
				message.Reference = &discordgo.MessageReference{
					MessageID: replyToMessageID,
					ChannelID: channelID,
				}
			}
			sent, err := b.session.ChannelMessageSendComplex(channelID, message)
			if err != nil {
				return first, err
			}
			if first == nil {
				first = sent
			}
		}
	}
	return first, nil
}
