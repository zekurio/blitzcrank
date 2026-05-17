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
	ApplicationCommandDelete(string, string, string, ...discordgo.RequestOption) error
}

type RuntimeManager interface {
	RunAutomation(context.Context, string) error
	AutomationNames() []string
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
	startedAt := time.Now()
	api := b.discordAPI()
	stepStartedAt := time.Now()
	if err := api.Open(); err != nil {
		log.Printf("discord startup step completed: name=open_gateway status=failed duration=%s", startupDuration(time.Since(stepStartedAt)))
		return err
	}
	log.Printf("discord startup step completed: name=open_gateway status=ok duration=%s", startupDuration(time.Since(stepStartedAt)))
	if b.session.State != nil && b.session.State.User != nil {
		b.botID = b.session.State.User.ID
		if err := b.registerRuntimeCommands(); err != nil {
			log.Printf("discord startup completed: status=failed bot_id=%s duration=%s", b.botID, startupDuration(time.Since(startedAt)))
			return err
		}
		log.Printf("discord startup completed: status=ok bot_id=%s duration=%s", b.botID, startupDuration(time.Since(startedAt)))
		return nil
	}
	stepStartedAt = time.Now()
	user, err := api.User("@me")
	if err != nil {
		log.Printf("discord startup step completed: name=load_current_user status=failed duration=%s", startupDuration(time.Since(stepStartedAt)))
		return err
	}
	log.Printf("discord startup step completed: name=load_current_user status=ok duration=%s", startupDuration(time.Since(stepStartedAt)))
	b.botID = user.ID
	if err := b.registerRuntimeCommands(); err != nil {
		log.Printf("discord startup completed: status=failed bot_id=%s duration=%s", b.botID, startupDuration(time.Since(startedAt)))
		return err
	}
	log.Printf("discord startup completed: status=ok bot_id=%s duration=%s", b.botID, startupDuration(time.Since(startedAt)))
	return nil
}

func (b *Bot) Close() {
	b.session.Close()
}

func (b *Bot) registerRuntimeCommands() error {
	if strings.TrimSpace(b.botID) == "" {
		return nil
	}
	api := b.discordAPI()
	startedAt := time.Now()
	stepStartedAt := time.Now()
	registeredCommands, err := api.ApplicationCommands(b.botID, b.cfg.DiscordGuildID)
	if err != nil {
		log.Printf("discord startup step completed: name=list_application_commands status=failed duration=%s", startupDuration(time.Since(stepStartedAt)))
		return err
	}
	log.Printf("discord startup step completed: name=list_application_commands status=ok count=%d duration=%s", len(registeredCommands), startupDuration(time.Since(stepStartedAt)))
	existing := map[string]string{}
	existingCommands := map[string]*discordgo.ApplicationCommand{}
	for _, command := range registeredCommands {
		if command == nil {
			continue
		}
		existing[command.Name] = command.ID
		existingCommands[command.Name] = command
	}
	desiredNames := map[string]bool{}
	var created, edited, unchanged, deleted int
	for _, command := range commands.ApplicationCommands() {
		desiredNames[command.Name] = true
		if id := existing[command.Name]; id != "" {
			if applicationCommandMatches(existingCommands[command.Name], command) {
				unchanged++
				continue
			}
			stepStartedAt = time.Now()
			if _, err := api.ApplicationCommandEdit(b.botID, b.cfg.DiscordGuildID, id, command); err != nil {
				log.Printf("discord startup step completed: name=edit_application_command command=%s status=failed duration=%s", command.Name, startupDuration(time.Since(stepStartedAt)))
				return err
			}
			edited++
			log.Printf("discord startup step completed: name=edit_application_command command=%s status=ok duration=%s", command.Name, startupDuration(time.Since(stepStartedAt)))
			continue
		}
		stepStartedAt = time.Now()
		if _, err := api.ApplicationCommandCreate(b.botID, b.cfg.DiscordGuildID, command); err != nil {
			log.Printf("discord startup step completed: name=create_application_command command=%s status=failed duration=%s", command.Name, startupDuration(time.Since(stepStartedAt)))
			return err
		}
		created++
		log.Printf("discord startup step completed: name=create_application_command command=%s status=ok duration=%s", command.Name, startupDuration(time.Since(stepStartedAt)))
	}
	for _, name := range retiredApplicationCommands() {
		if desiredNames[name] {
			continue
		}
		id := existing[name]
		if id == "" {
			continue
		}
		stepStartedAt = time.Now()
		if err := api.ApplicationCommandDelete(b.botID, b.cfg.DiscordGuildID, id); err != nil {
			log.Printf("discord startup step completed: name=delete_application_command command=%s status=failed duration=%s", name, startupDuration(time.Since(stepStartedAt)))
			return err
		}
		deleted++
		log.Printf("discord startup step completed: name=delete_application_command command=%s status=ok duration=%s", name, startupDuration(time.Since(stepStartedAt)))
	}
	log.Printf("discord startup command sync completed: created=%d edited=%d deleted=%d unchanged=%d duration=%s", created, edited, deleted, unchanged, startupDuration(time.Since(startedAt)))
	return nil
}

func retiredApplicationCommands() []string {
	return []string{"config", commands.LegacyReleasesCommand}
}

func applicationCommandMatches(existing, desired *discordgo.ApplicationCommand) bool {
	if existing == nil || desired == nil {
		return false
	}
	return existing.Name == desired.Name &&
		existing.Description == desired.Description &&
		applicationCommandType(existing.Type) == applicationCommandType(desired.Type) &&
		int64PtrEqual(existing.DefaultMemberPermissions, desired.DefaultMemberPermissions) &&
		omittedBoolPtrEqual(existing.DMPermission, desired.DMPermission) &&
		commandBoolPtrEqual(existing.NSFW, desired.NSFW, false) &&
		commandLocalizationPtrEqual(existing.NameLocalizations, desired.NameLocalizations) &&
		commandLocalizationPtrEqual(existing.DescriptionLocalizations, desired.DescriptionLocalizations) &&
		interactionContextsEqual(existing.Contexts, desired.Contexts) &&
		applicationIntegrationTypesEqual(existing.IntegrationTypes, desired.IntegrationTypes) &&
		applicationCommandOptionsEqual(existing.Options, desired.Options)
}

func applicationCommandType(commandType discordgo.ApplicationCommandType) discordgo.ApplicationCommandType {
	if commandType == 0 {
		return discordgo.ChatApplicationCommand
	}
	return commandType
}

func int64PtrEqual(a, b *int64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func commandBoolPtrEqual(existing, desired *bool, defaultValue bool) bool {
	return boolValue(existing, defaultValue) == boolValue(desired, defaultValue)
}

func omittedBoolPtrEqual(existing, desired *bool) bool {
	if existing == nil || desired == nil {
		return true
	}
	return *existing == *desired
}

func boolValue(value *bool, defaultValue bool) bool {
	if value == nil {
		return defaultValue
	}
	return *value
}

func commandLocalizationPtrEqual(existing, desired *map[discordgo.Locale]string) bool {
	return localizationMapEqual(localizationPtrValue(existing), localizationPtrValue(desired))
}

func localizationPtrValue(value *map[discordgo.Locale]string) map[discordgo.Locale]string {
	if value == nil {
		return nil
	}
	return *value
}

func localizationMapEqual(existing, desired map[discordgo.Locale]string) bool {
	if len(existing) != len(desired) {
		return false
	}
	for key, value := range existing {
		if desired[key] != value {
			return false
		}
	}
	return true
}

func interactionContextsEqual(existing, desired *[]discordgo.InteractionContextType) bool {
	if desired == nil || len(*desired) == 0 {
		return true
	}
	if existing == nil || len(*existing) != len(*desired) {
		return false
	}
	for i := range *desired {
		if (*existing)[i] != (*desired)[i] {
			return false
		}
	}
	return true
}

func applicationIntegrationTypesEqual(existing, desired *[]discordgo.ApplicationIntegrationType) bool {
	if desired == nil || len(*desired) == 0 {
		return true
	}
	if existing == nil || len(*existing) != len(*desired) {
		return false
	}
	for i := range *desired {
		if (*existing)[i] != (*desired)[i] {
			return false
		}
	}
	return true
}

func applicationCommandOptionsEqual(existing, desired []*discordgo.ApplicationCommandOption) bool {
	if len(existing) != len(desired) {
		return false
	}
	for i := range desired {
		if !applicationCommandOptionEqual(existing[i], desired[i]) {
			return false
		}
	}
	return true
}

func applicationCommandOptionEqual(existing, desired *discordgo.ApplicationCommandOption) bool {
	if existing == nil || desired == nil {
		return existing == desired
	}
	return existing.Type == desired.Type &&
		existing.Name == desired.Name &&
		existing.Description == desired.Description &&
		localizationMapEqual(existing.NameLocalizations, desired.NameLocalizations) &&
		localizationMapEqual(existing.DescriptionLocalizations, desired.DescriptionLocalizations) &&
		channelTypesEqual(existing.ChannelTypes, desired.ChannelTypes) &&
		existing.Required == desired.Required &&
		existing.Autocomplete == desired.Autocomplete &&
		float64PtrEqual(existing.MinValue, desired.MinValue) &&
		existing.MaxValue == desired.MaxValue &&
		intPtrEqual(existing.MinLength, desired.MinLength) &&
		existing.MaxLength == desired.MaxLength &&
		applicationCommandOptionsEqual(existing.Options, desired.Options) &&
		applicationCommandChoicesEqual(existing.Choices, desired.Choices)
}

func channelTypesEqual(existing, desired []discordgo.ChannelType) bool {
	if len(existing) != len(desired) {
		return false
	}
	for i := range desired {
		if existing[i] != desired[i] {
			return false
		}
	}
	return true
}

func applicationCommandChoicesEqual(existing, desired []*discordgo.ApplicationCommandOptionChoice) bool {
	if len(existing) != len(desired) {
		return false
	}
	for i := range desired {
		if !applicationCommandChoiceEqual(existing[i], desired[i]) {
			return false
		}
	}
	return true
}

func applicationCommandChoiceEqual(existing, desired *discordgo.ApplicationCommandOptionChoice) bool {
	if existing == nil || desired == nil {
		return existing == desired
	}
	return existing.Name == desired.Name &&
		existing.Value == desired.Value &&
		localizationMapEqual(existing.NameLocalizations, desired.NameLocalizations)
}

func float64PtrEqual(a, b *float64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func intPtrEqual(a, b *int) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func startupDuration(duration time.Duration) time.Duration {
	return duration.Round(time.Millisecond)
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
