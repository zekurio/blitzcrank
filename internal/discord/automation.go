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
		log.Printf("discord automation bot disabled: DISCORD_AUTOMATION_CHANNEL_ID is not set")
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

type automationRunStatus string

const (
	automationRunStarted automationRunStatus = "started"
	automationRunOK      automationRunStatus = "ok"
	automationRunWarning automationRunStatus = "warning"
	automationRunError   automationRunStatus = "error"
	automationRunEmpty   automationRunStatus = "empty"
)

func (b *Bot) Reporter() *AutomationReporter {
	if b == nil || b.session == nil {
		return nil
	}
	return &AutomationReporter{cfg: b.cfg, session: b.session}
}

func (r *AutomationReporter) AutomationStarted(ctx context.Context, task automation.Task) (automation.ReportHandle, error) {
	if r == nil || r.session == nil || strings.TrimSpace(r.cfg.DiscordAutomationChannelID) == "" {
		return automation.ReportHandle{}, nil
	}
	thread, err := r.ensureAutomationThread(task)
	if err != nil {
		return automation.ReportHandle{}, err
	}
	embed := automationStartedEmbed(task)
	messageID, err := r.latestAutomationStatusMessageID(thread.ID)
	if err == nil && messageID != "" {
		_, err = r.session.ChannelMessageEditEmbed(thread.ID, messageID, embed)
	} else if err == nil {
		var msg *discordgo.Message
		msg, err = r.session.ChannelMessageSendEmbed(thread.ID, embed)
		if err == nil && msg != nil {
			messageID = msg.ID
		}
	}
	if lockErr := r.lockAutomationThread(thread.ID); lockErr != nil && err == nil {
		err = lockErr
	}
	if err != nil {
		return automation.ReportHandle{ThreadID: thread.ID, MessageID: messageID}, err
	}
	return automation.ReportHandle{ThreadID: thread.ID, MessageID: messageID}, nil
}

func (r *AutomationReporter) AutomationCompleted(ctx context.Context, handle automation.ReportHandle, task automation.Task, response string, runErr error, failures []automation.ToolFailure) error {
	if r == nil || r.session == nil {
		return nil
	}
	threadID := strings.TrimSpace(handle.ThreadID)
	if threadID == "" {
		thread, err := r.ensureAutomationThread(task)
		if err != nil {
			return err
		}
		threadID = thread.ID
	}
	if err := r.unlockAutomationThreadForPost(threadID); err != nil {
		return err
	}
	embed := automationCompletedEmbed(task, response, runErr, failures)
	messageID := strings.TrimSpace(handle.MessageID)
	var err error
	if embed == nil {
		if messageID != "" {
			err = r.session.ChannelMessageDelete(threadID, messageID)
		}
	} else if messageID != "" {
		_, err = r.session.ChannelMessageEditEmbed(threadID, messageID, embed)
	} else {
		_, err = r.session.ChannelMessageSendEmbed(threadID, embed)
	}
	if lockErr := r.lockAutomationThread(threadID); lockErr != nil && err == nil {
		err = lockErr
	}
	return err
}

func (r *AutomationReporter) ensureAutomationThread(task automation.Task) (*discordgo.Channel, error) {
	name := automationThreadName(task)
	if thread, err := r.findAutomationThread(name); err != nil {
		return nil, err
	} else if thread != nil {
		if err := r.unlockAutomationThreadForPost(thread.ID); err != nil {
			return nil, err
		}
		return thread, nil
	}
	thread, err := r.session.ThreadStartComplex(r.cfg.DiscordAutomationChannelID, &discordgo.ThreadStart{
		Name:                name,
		Type:                discordgo.ChannelTypeGuildPublicThread,
		AutoArchiveDuration: 1440,
		Invitable:           false,
	})
	if err != nil {
		return nil, err
	}
	return thread, nil
}

func (r *AutomationReporter) findAutomationThread(name string) (*discordgo.Channel, error) {
	active, err := r.session.ThreadsActive(r.cfg.DiscordAutomationChannelID)
	if err != nil {
		return nil, err
	}
	if thread := findThreadByName(active, name); thread != nil {
		return thread, nil
	}
	archived, err := r.session.ThreadsArchived(r.cfg.DiscordAutomationChannelID, nil, 100)
	if err != nil {
		return nil, err
	}
	return findThreadByName(archived, name), nil
}

func findThreadByName(list *discordgo.ThreadsList, name string) *discordgo.Channel {
	if list == nil {
		return nil
	}
	for _, thread := range list.Threads {
		if strings.EqualFold(strings.TrimSpace(thread.Name), strings.TrimSpace(name)) {
			return thread
		}
	}
	return nil
}

func (r *AutomationReporter) unlockAutomationThreadForPost(threadID string) error {
	archived := false
	locked := false
	_, err := r.session.ChannelEditComplex(threadID, &discordgo.ChannelEdit{Archived: &archived, Locked: &locked})
	return err
}

func (r *AutomationReporter) lockAutomationThread(threadID string) error {
	if !r.cfg.DiscordAutomationThreadLock {
		return nil
	}
	locked := true
	_, err := r.session.ChannelEditComplex(threadID, &discordgo.ChannelEdit{Locked: &locked})
	return err
}

func (r *AutomationReporter) latestAutomationStatusMessageID(threadID string) (string, error) {
	messages, err := r.session.ChannelMessages(threadID, 100, "", "", "")
	if err != nil {
		return "", err
	}
	botID := ""
	if r.session.State != nil && r.session.State.User != nil {
		botID = strings.TrimSpace(r.session.State.User.ID)
	}
	for _, message := range messages {
		if message == nil || strings.TrimSpace(message.ID) == "" {
			continue
		}
		if botID != "" && (message.Author == nil || message.Author.ID != botID) {
			continue
		}
		if isAutomationStatusMessage(message) {
			return message.ID, nil
		}
	}
	return "", nil
}

func isAutomationStatusMessage(message *discordgo.Message) bool {
	for _, embed := range message.Embeds {
		if embed == nil {
			continue
		}
		title := strings.TrimSpace(embed.Title)
		for _, icon := range []string{"❌", "⚠️", "ℹ️", "🚀", "✅"} {
			if strings.HasPrefix(title, icon+" ") {
				return true
			}
		}
	}
	return false
}

func automationThreadName(task automation.Task) string {
	return "automation: " + task.Name
}

func automationStartedEmbed(task automation.Task) *discordgo.MessageEmbed {
	description := "Der Lauf wurde gestartet. Ergebnisse werden in diesem Thread gepostet."
	if strings.TrimSpace(task.Description) != "" {
		description += "\n\n" + strings.TrimSpace(task.Description)
	}
	return automationEmbed(automationRunStarted, task, "Lauf gestartet", description)
}

func automationCompletedEmbed(task automation.Task, response string, runErr error, failures []automation.ToolFailure) *discordgo.MessageEmbed {
	description := strings.TrimSpace(response)
	failureSummary := formatToolFailures(failures)
	if runErr != nil {
		description = fmt.Sprintf("Konnte nicht ausgeführt werden: %v", runErr)
		if failureSummary != "" {
			description += "\n" + failureSummary
		}
		return automationEmbed(automationRunError, task, "Fehler", description)
	}
	if failureSummary != "" {
		description = conciseFailureDescription(description, failureSummary)
		return automationEmbed(automationRunError, task, "Tool-Fehler", description)
	}
	if description == "" {
		return nil
	}
	status, remainder, ok := parseExplicitStatus(description)
	if ok {
		description = remainder
		if description == "" {
			return nil
		}
	} else {
		status = classifyAutomationResponse(description)
	}
	decorated := trimLeadingSingleAutomationHeading(decorateAutomationOutput(description))
	return automationEmbed(status, task, automationStatusTitle(status), decorated)
}

// parseExplicitStatus extracts a leading "STATUS: ok|warnung|fehler" line that
// automations may emit as their first line, returning the remaining text.
func parseExplicitStatus(response string) (automationRunStatus, string, bool) {
	trimmed := strings.TrimSpace(response)
	line, rest, _ := strings.Cut(trimmed, "\n")
	value, ok := strings.CutPrefix(strings.TrimSpace(strings.ToLower(line)), "status:")
	if !ok {
		return automationRunOK, response, false
	}
	switch strings.TrimSpace(value) {
	case "ok":
		return automationRunOK, strings.TrimSpace(rest), true
	case "warnung", "warning":
		return automationRunWarning, strings.TrimSpace(rest), true
	case "fehler", "error":
		return automationRunError, strings.TrimSpace(rest), true
	default:
		return automationRunOK, response, false
	}
}

func conciseFailureDescription(response string, failureSummary string) string {
	response = strings.TrimSpace(response)
	if response == "" {
		return failureSummary
	}
	return "**Kurzfassung:** " + firstNonEmptyLine(response) + "\n" + failureSummary
}

func formatToolFailures(failures []automation.ToolFailure) string {
	if len(failures) == 0 {
		return ""
	}
	tools := make([]string, 0, len(failures))
	seen := map[string]bool{}
	reason := "Fehler beim Dienstaufruf"
	for _, failure := range failures {
		tool := strings.TrimSpace(failure.Tool)
		if tool != "" && !seen[tool] {
			seen[tool] = true
			tools = append(tools, "`"+tool+"`")
		}
		if strings.Contains(strings.ToLower(failure.Error), "timeout") {
			reason = "Timeout beim Dienstaufruf"
		}
	}
	if len(tools) == 0 {
		tools = append(tools, "unbekannt")
	}
	return "**Tools:** " + strings.Join(tools, ", ") + "\n**Grund:** " + reason
}

func firstNonEmptyLine(value string) string {
	for _, line := range strings.Split(value, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			return line
		}
	}
	return strings.TrimSpace(value)
}

func automationEmbed(status automationRunStatus, task automation.Task, title string, description string) *discordgo.MessageEmbed {
	embed := &discordgo.MessageEmbed{
		Title:       automationStatusIcon(status) + " " + title,
		Description: truncateDiscordDescription(description),
		Color:       automationStatusColor(status),
		Timestamp:   time.Now().UTC().Format(time.RFC3339),
	}
	if footer := automationFooterText(task); footer != "" {
		embed.Footer = &discordgo.MessageEmbedFooter{Text: footer}
	}
	return embed
}

func automationFooterText(task automation.Task) string {
	if schedule := strings.TrimSpace(task.Schedule); schedule != "" {
		return "Zeitplan: " + schedule
	}
	return ""
}

func classifyAutomationResponse(response string) automationRunStatus {
	value := strings.ToLower(response)
	switch {
	case strings.Contains(value, "konnte nicht ausgeführt werden"), strings.Contains(value, "fehlgeschlagen"), strings.Contains(value, "fehler"), strings.Contains(value, "timeout"):
		return automationRunError
	case strings.Contains(value, "manuell prüfen"), strings.Contains(value, "manual"), strings.Contains(value, "prüfen"), strings.Contains(value, "intervention"):
		return automationRunWarning
	default:
		return automationRunOK
	}
}

func automationStatusTitle(status automationRunStatus) string {
	switch status {
	case automationRunError:
		return "Fehler"
	case automationRunWarning:
		return "Manuelle Prüfung nötig"
	case automationRunEmpty:
		return "Keine Änderungen"
	case automationRunStarted:
		return "Lauf gestartet"
	default:
		return "Abgeschlossen"
	}
}

func automationStatusIcon(status automationRunStatus) string {
	switch status {
	case automationRunError:
		return "❌"
	case automationRunWarning:
		return "⚠️"
	case automationRunEmpty:
		return "ℹ️"
	case automationRunStarted:
		return "🚀"
	default:
		return "✅"
	}
}

func automationStatusColor(status automationRunStatus) int {
	switch status {
	case automationRunError:
		return 0xf85149
	case automationRunWarning:
		return 0xd29922
	case automationRunEmpty:
		return 0x8b949e
	case automationRunStarted:
		return 0x58a6ff
	default:
		return 0x3fb950
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

func trimLeadingSingleAutomationHeading(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	lines := strings.Split(value, "\n")
	headingCount := 0
	for _, line := range lines {
		if isAutomationOutputHeading(line) {
			headingCount++
		}
	}
	if headingCount != 1 || !isAutomationOutputHeading(lines[0]) {
		return value
	}
	return strings.TrimSpace(strings.Join(lines[1:], "\n"))
}

func isAutomationOutputHeading(line string) bool {
	switch strings.TrimSpace(line) {
	case "### ✅ Importiert", "### 🗑️ Entfernt", "### ⚠️ Manuell prüfen":
		return true
	default:
		return false
	}
}

func truncateCodeBlock(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len([]rune(value)) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit]) + "\n… gekürzt"
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
