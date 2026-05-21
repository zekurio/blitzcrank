package discord

import (
	"context"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"

	"blitzcrank/internal/automation"
	"blitzcrank/internal/config"

	"github.com/bwmarrin/discordgo"
)

type Scheduler interface {
	RunAutomation(context.Context, string) error
	AutomationNames() []string
}

type Bot struct {
	cfg       config.Config
	session   *discordgo.Session
	scheduler Scheduler
}

func New(cfg config.Config, scheduler Scheduler) (*Bot, error) {
	if strings.TrimSpace(cfg.DiscordToken) == "" {
		log.Printf("discord automation bot disabled: DISCORD_TOKEN is not set")
		return nil, nil
	}
	if strings.TrimSpace(cfg.DiscordAutomationChannelID) == "" {
		log.Printf("discord automation bot disabled: DISCORD_AUTOMATION_CHANNEL_ID or DISCORD_CHANNEL_ID is not set")
		return nil, nil
	}
	s, err := discordgo.New("Bot " + strings.TrimSpace(cfg.DiscordToken))
	if err != nil {
		return nil, err
	}
	s.Identify.Intents = discordgo.IntentsGuilds
	bot := &Bot{cfg: cfg, session: s, scheduler: scheduler}
	s.AddHandler(bot.onInteractionCreate)
	return bot, nil
}

func (b *Bot) Start() error {
	if b == nil {
		return nil
	}
	if err := b.session.Open(); err != nil {
		return err
	}
	if err := b.registerCommands(); err != nil {
		_ = b.session.Close()
		return err
	}
	log.Printf("discord automation bot started: channel=%s", b.cfg.DiscordAutomationChannelID)
	return nil
}

func (b *Bot) Close() error {
	if b == nil || b.session == nil {
		return nil
	}
	return b.session.Close()
}

func (b *Bot) registerCommands() error {
	permissions := int64(discordgo.PermissionManageThreads)
	choices := make([]*discordgo.ApplicationCommandOptionChoice, 0)
	if b.scheduler != nil {
		names := b.scheduler.AutomationNames()
		sort.Strings(names)
		for _, name := range names {
			if strings.TrimSpace(name) == "" {
				continue
			}
			choices = append(choices, &discordgo.ApplicationCommandOptionChoice{Name: name, Value: name})
			if len(choices) >= 25 {
				break
			}
		}
	}
	cmd := &discordgo.ApplicationCommand{
		Name:                     "automatisierung",
		Description:              "Startet eine geladene Blitzcrank-Automatisierung.",
		DefaultMemberPermissions: &permissions,
		Options: []*discordgo.ApplicationCommandOption{{
			Type:        discordgo.ApplicationCommandOptionString,
			Name:        "name",
			Description: "Name der Automatisierung",
			Required:    true,
			Choices:     choices,
		}},
	}
	_, err := b.session.ApplicationCommandCreate(b.session.State.User.ID, strings.TrimSpace(b.cfg.DiscordGuildID), cmd)
	return err
}

func (b *Bot) onInteractionCreate(s *discordgo.Session, i *discordgo.InteractionCreate) {
	if i.Type != discordgo.InteractionApplicationCommand || i.ApplicationCommandData().Name != "automatisierung" {
		return
	}
	name := ""
	for _, option := range i.ApplicationCommandData().Options {
		if option.Name == "name" {
			name = option.StringValue()
		}
	}
	if strings.TrimSpace(name) == "" {
		_ = s.InteractionRespond(i.Interaction, ephemeral("Name fehlt."))
		return
	}
	if b.scheduler == nil {
		_ = s.InteractionRespond(i.Interaction, ephemeral("Automatisierungen sind nicht verfügbar."))
		return
	}
	_ = s.InteractionRespond(i.Interaction, ephemeral(fmt.Sprintf("Automatisierung `%s` wurde gestartet.", name)))
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), b.cfg.RunTimeout)
		defer cancel()
		if err := b.scheduler.RunAutomation(ctx, name); err != nil {
			log.Printf("discord-triggered automation failed: name=%s error=%v", name, err)
		}
	}()
}

func ephemeral(content string) *discordgo.InteractionResponse {
	return &discordgo.InteractionResponse{Type: discordgo.InteractionResponseChannelMessageWithSource, Data: &discordgo.InteractionResponseData{Content: content, Flags: discordgo.MessageFlagsEphemeral}}
}

type AutomationReporter struct {
	cfg     config.Config
	session *discordgo.Session
}

func (b *Bot) Reporter() *AutomationReporter {
	if b == nil || b.session == nil {
		return nil
	}
	return &AutomationReporter{cfg: b.cfg, session: b.session}
}

func (r *AutomationReporter) AutomationStarted(ctx context.Context, task automation.Task) (string, error) {
	if r == nil || r.session == nil || strings.TrimSpace(r.cfg.DiscordAutomationChannelID) == "" {
		return "", nil
	}
	thread, err := r.session.ThreadStartComplex(r.cfg.DiscordAutomationChannelID, &discordgo.ThreadStart{
		Name:                "automation: " + task.Name,
		Type:                discordgo.ChannelTypeGuildPublicThread,
		AutoArchiveDuration: 1440,
		Invitable:           false,
	})
	if err != nil {
		return "", err
	}
	_, _ = r.session.ChannelMessageSendEmbed(thread.ID, automationStartedEmbed(task))
	if r.cfg.DiscordAutomationThreadLock {
		locked := true
		_, err = r.session.ChannelEditComplex(thread.ID, &discordgo.ChannelEdit{Locked: &locked})
		if err != nil {
			return thread.ID, err
		}
	}
	return thread.ID, nil
}

func (r *AutomationReporter) AutomationCompleted(ctx context.Context, threadID string, task automation.Task, response string, runErr error) error {
	if r == nil || r.session == nil || strings.TrimSpace(threadID) == "" {
		return nil
	}
	_, err := r.session.ChannelMessageSendEmbed(threadID, automationCompletedEmbed(task, response, runErr))
	return err
}

func automationStartedEmbed(task automation.Task) *discordgo.MessageEmbed {
	description := fmt.Sprintf("Automatisierung `%s` wurde gestartet.\n<t:%d:R>", task.Name, time.Now().Unix())
	if strings.TrimSpace(task.Description) != "" {
		description += "\n\n" + strings.TrimSpace(task.Description)
	}
	return &discordgo.MessageEmbed{
		Title:       "Automatisierung gestartet",
		Description: truncateDiscordDescription(description),
		Color:       0x58a6ff,
		Timestamp:   time.Now().Format(time.RFC3339),
		Footer:      &discordgo.MessageEmbedFooter{Text: task.Name},
	}
}

func automationCompletedEmbed(task automation.Task, response string, runErr error) *discordgo.MessageEmbed {
	status := "Abgeschlossen"
	color := 0x3fb950
	description := strings.TrimSpace(response)
	if runErr != nil {
		status = "Fehlgeschlagen"
		color = 0xf85149
		description = fmt.Sprintf("Automatisierung `%s` konnte nicht ausgeführt werden.\n\n**Fehler:** %v", task.Name, runErr)
	} else if description == "" {
		status = "Keine Änderungen"
		color = 0x8b949e
		description = "Keine meldepflichtigen Änderungen gefunden."
	} else {
		description = decorateAutomationOutput(description)
	}
	return &discordgo.MessageEmbed{
		Title:       "Automatisierung: " + status,
		Description: truncateDiscordDescription(description),
		Color:       color,
		Timestamp:   time.Now().Format(time.RFC3339),
		Footer:      &discordgo.MessageEmbedFooter{Text: task.Name},
	}
}

func decorateAutomationOutput(value string) string {
	lines := strings.Split(strings.TrimSpace(value), "\n")
	for i, line := range lines {
		switch strings.TrimSpace(line) {
		case "Importiert:":
			lines[i] = "### ✅ Importiert"
		case "Entfernt:":
			lines[i] = "### 🗑️ Entfernt"
		case "Manuell prüfen:":
			lines[i] = "### ⚠️ Manuell prüfen"
		}
	}
	return strings.Join(lines, "\n")
}

func truncateDiscordDescription(value string) string {
	value = strings.TrimSpace(value)
	const limit = 3900
	if len([]rune(value)) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit]) + "\n\n… gekürzt"
}
