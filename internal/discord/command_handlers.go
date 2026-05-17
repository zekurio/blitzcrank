package discord

import (
	"context"
	"log"
	"strings"
	"time"

	"blitzcrank/internal/discord/commands"

	"github.com/bwmarrin/discordgo"
)

func (b *Bot) onInteractionCreate(session *discordgo.Session, event *discordgo.InteractionCreate) {
	if event == nil || event.Interaction == nil {
		return
	}
	if b.handleFeedbackComponent(session, event) {
		return
	}
	if b.handleFeedbackModal(session, event) {
		return
	}
	if event.Type == discordgo.InteractionApplicationCommandAutocomplete {
		b.handleAutocomplete(session, event)
		return
	}
	if event.Type != discordgo.InteractionApplicationCommand {
		return
	}
	data := event.ApplicationCommandData()
	switch data.Name {
	case commands.ConfigCommand:
		b.handleConfigRootSlashCommand(session, event, data)
	case commands.AutomationCommand:
		b.handleLeanAutomationSlashCommand(session, event, data)
	default:
		if groups, ok := commands.SkillCommandGroups[data.Name]; ok {
			b.handleSkillSlashCommand(session, event, data.Name, groups)
		}
	}
}

func (b *Bot) handleAutocomplete(session *discordgo.Session, event *discordgo.InteractionCreate) {
	data := event.ApplicationCommandData()
	if data.Name != commands.AutomationCommand {
		return
	}
	choices := b.automationChoices(commands.StringOption(data, "name"))
	if err := session.InteractionRespond(event.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionApplicationCommandAutocompleteResult,
		Data: &discordgo.InteractionResponseData{Choices: choices},
	}); err != nil {
		log.Printf("send automation autocomplete response failed: %v", err)
	}
}

func (b *Bot) handleConfigRootSlashCommand(session *discordgo.Session, event *discordgo.InteractionCreate, data discordgo.ApplicationCommandInteractionData) {
	group, sub := commands.FirstSubcommandPath(data)
	if sub == nil {
		b.respondEphemeral(session, event, "Config subcommand is required.")
		return
	}
	if group == "" {
		switch sub.Name {
		case "restart":
			b.handleRestartSlashCommand(session, event)
		case "reload-skills":
			b.handleRuntimeSlashCommand(session, event, "skills")
		case "reload-automations":
			b.handleRuntimeSlashCommand(session, event, "automations")
		default:
			b.respondEphemeral(session, event, "Unknown config subcommand.")
		}
		return
	}
	switch group {
	case "global", "profile":
		b.handleConfigSlashCommand(session, event, group, sub)
	case "automation":
		b.handleAutomationSlashCommand(session, event, sub)
	default:
		b.respondEphemeral(session, event, "Unknown config command group.")
	}
}

func (b *Bot) handleRuntimeSlashCommand(session *discordgo.Session, event *discordgo.InteractionCreate, target string) {
	initialReply := "Reloading runtime " + target + "."
	if !b.isAdminInteraction(event) {
		b.respondEphemeral(session, event, "Only the configured owner or Discord administrators can use this command.")
		return
	}
	if b.runtime == nil {
		b.respondEphemeral(session, event, "Runtime manager is not ready yet.")
		return
	}
	if err := session.InteractionRespond(event.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{
			Content: initialReply,
			Flags:   discordgo.MessageFlagsEphemeral,
		},
	}); err != nil {
		log.Printf("send runtime slash command response failed: %v", err)
		return
	}

	reply := "Reloaded runtime " + target + "."
	var err error
	switch target {
	case "skills":
		err = b.runtime.ReloadSkills()
	case "automations":
		err = b.runtime.ReloadAutomations()
	default:
		reply = "Unknown runtime reload target."
	}
	if err != nil {
		log.Printf("runtime slash command failed: command=%s error=%v", target, err)
		reply = "Reload failed. Check the bot logs for details."
	}
	if _, editErr := session.InteractionResponseEdit(event.Interaction, &discordgo.WebhookEdit{
		Content:         &reply,
		AllowedMentions: &discordgo.MessageAllowedMentions{},
	}); editErr != nil {
		log.Printf("edit runtime slash command response failed: %v", editErr)
	}
}

func (b *Bot) handleConfigSlashCommand(session *discordgo.Session, event *discordgo.InteractionCreate, group string, sub *discordgo.ApplicationCommandInteractionDataOption) {
	if !b.isAdminInteraction(event) {
		b.respondEphemeral(session, event, "Only the configured owner or Discord administrators can use this command.")
		return
	}
	if b.runtime == nil {
		b.respondEphemeral(session, event, "Runtime manager is not ready yet.")
		return
	}
	if sub == nil {
		b.respondEphemeral(session, event, "Config subcommand is required.")
		return
	}
	key := ""
	switch group {
	case "global":
		key = commands.OptionString(sub, "key")
	case "profile":
		key = "runtime." + commands.OptionString(sub, "profile") + "." + commands.OptionString(sub, "field")
	default:
		b.respondEphemeral(session, event, "Unknown config command group.")
		return
	}
	switch sub.Name {
	case "set":
		if err := b.runtime.ConfigSet(key, commands.OptionString(sub, "value")); err != nil {
			b.respondEphemeral(session, event, "Config update failed: "+err.Error())
			return
		}
		b.respondEphemeral(session, event, "Updated `"+key+"`.")
		return
	case "get":
	default:
		b.respondEphemeral(session, event, "Unknown config subcommand.")
		return
	}
	value, err := b.runtime.ConfigGet(key)
	if err != nil {
		b.respondEphemeral(session, event, "Config read failed: "+err.Error())
		return
	}
	if strings.Contains(key, "api_key") && strings.TrimSpace(value) != "" {
		value = "[set]"
	}
	b.respondEphemeral(session, event, "`"+key+"` = `"+value+"`")
}

func (b *Bot) handleRestartSlashCommand(session *discordgo.Session, event *discordgo.InteractionCreate) {
	if !b.isAdminInteraction(event) {
		b.respondEphemeral(session, event, "Only the configured owner or Discord administrators can use this command.")
		return
	}
	if b.runtime == nil {
		b.respondEphemeral(session, event, "Runtime manager is not ready yet.")
		return
	}
	b.respondEphemeral(session, event, "Restarting Blitzcrank.")
	go func() {
		time.Sleep(500 * time.Millisecond)
		b.runtime.Restart()
	}()
}

func (b *Bot) handleAutomationSlashCommand(session *discordgo.Session, event *discordgo.InteractionCreate, sub *discordgo.ApplicationCommandInteractionDataOption) {
	if !b.isAdminInteraction(event) {
		b.respondEphemeral(session, event, "Only the configured owner or Discord administrators can use this command.")
		return
	}
	if b.runtime == nil {
		b.respondEphemeral(session, event, "Runtime manager is not ready yet.")
		return
	}
	if sub == nil {
		b.respondEphemeral(session, event, "Automation subcommand is required.")
		return
	}
	switch sub.Name {
	case "list":
		b.respondEphemeral(session, event, b.runtime.AutomationStatus(time.Now()))
	case "reload":
		if err := b.runtime.ReloadAutomations(); err != nil {
			b.respondEphemeral(session, event, "Automation reload failed: "+err.Error())
			return
		}
		b.respondEphemeral(session, event, "Reloaded automations.")
	case "run":
		name := commands.OptionString(sub, "name")
		b.runAutomationFromSlash(session, event, name)
	default:
		b.respondEphemeral(session, event, "Unknown automation subcommand.")
	}
}

func (b *Bot) handleLeanAutomationSlashCommand(session *discordgo.Session, event *discordgo.InteractionCreate, data discordgo.ApplicationCommandInteractionData) {
	if !b.isAdminInteraction(event) {
		b.respondEphemeral(session, event, "Only the configured owner or Discord administrators can use this command.")
		return
	}
	if b.runtime == nil {
		b.respondEphemeral(session, event, "Runtime manager is not ready yet.")
		return
	}
	b.runAutomationFromSlash(session, event, commands.StringOption(data, "name"))
}

func (b *Bot) runAutomationFromSlash(session *discordgo.Session, event *discordgo.InteractionCreate, name string) {
	name = strings.TrimSpace(name)
	if name == "" {
		b.respondEphemeral(session, event, "Automation name is required.")
		return
	}
	b.respondEphemeral(session, event, "Running automation `"+name+"`.")
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), b.cfg.RunTimeout)
		defer cancel()
		if err := b.runtime.RunAutomation(ctx, name); err != nil {
			log.Printf("manual automation run failed: automation=%s error=%v", name, err)
		}
	}()
}

func (b *Bot) automationChoices(input string) []*discordgo.ApplicationCommandOptionChoice {
	if b.runtime == nil {
		return nil
	}
	input = strings.ToLower(strings.TrimSpace(input))
	names := b.runtime.AutomationNames()
	choices := make([]*discordgo.ApplicationCommandOptionChoice, 0, min(len(names), 25))
	for _, name := range names {
		if input != "" && !strings.Contains(strings.ToLower(name), input) {
			continue
		}
		choices = append(choices, &discordgo.ApplicationCommandOptionChoice{Name: name, Value: name})
		if len(choices) == 25 {
			break
		}
	}
	return choices
}

func (b *Bot) handleSkillSlashCommand(session *discordgo.Session, event *discordgo.InteractionCreate, skill string, groups []string) {
	prompt := commands.SlashPrompt(event.ApplicationCommandData())
	if strings.TrimSpace(prompt) == "" {
		b.respondEphemeral(session, event, "Prompt is required.")
		return
	}
	if err := session.InteractionRespond(event.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseDeferredChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{
			AllowedMentions: &discordgo.MessageAllowedMentions{},
		},
	}); err != nil {
		log.Printf("defer skill slash command failed: skill=%s error=%v", skill, err)
		return
	}

	rootContent := b.skillSlashRootMessage(event, skill, prompt)
	message, err := session.InteractionResponseEdit(event.Interaction, &discordgo.WebhookEdit{
		Content:         &rootContent,
		AllowedMentions: &discordgo.MessageAllowedMentions{},
	})
	if err != nil {
		log.Printf("edit skill slash command root response failed: skill=%s error=%v", skill, err)
		return
	}
	if message == nil {
		return
	}
	thread, err := session.MessageThreadStart(message.ChannelID, message.ID, threadTitle(prompt), b.cfg.DiscordThreadArchiveMinutes)
	if err != nil {
		log.Printf("create slash command thread failed: skill=%s message=%s error=%v", skill, message.ID, err)
		fallback := "Thread-Erstellung fehlgeschlagen. Bitte pruefe die Bot-Berechtigungen fuer Threads."
		if _, editErr := session.InteractionResponseEdit(event.Interaction, &discordgo.WebhookEdit{
			Content:         &fallback,
			AllowedMentions: &discordgo.MessageAllowedMentions{},
		}); editErr != nil {
			log.Printf("edit slash command failure response failed: skill=%s error=%v", skill, editErr)
		}
		return
	}

	rootEvent := slashInteractionMessage(event, message)
	content := discordSkillPrompt(skill, prompt)
	if err := b.recordDiscordThread(context.Background(), recordDiscordThreadRequest{
		ThreadID:      thread.ID,
		ParentID:      message.ChannelID,
		RootMessageID: message.ID,
		Title:         thread.Name,
		Event:         rootEvent,
		EventType:     "slash_" + skill,
		Content:       content,
		ToolGroups:    groups,
	}); err != nil {
		log.Printf("record discord slash thread failed: thread=%s error=%v", thread.ID, err)
	}
	go b.runThreadAgent(context.Background(), session, thread.ID, rootEvent, content, "slash_"+skill)
}

func (b *Bot) respondEphemeral(session *discordgo.Session, event *discordgo.InteractionCreate, content string) {
	if err := session.InteractionRespond(event.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{
			Content: content,
			Flags:   discordgo.MessageFlagsEphemeral,
		},
	}); err != nil {
		log.Printf("send ephemeral response failed: %v", err)
	}
}

func (b *Bot) isAdminInteraction(event *discordgo.InteractionCreate) bool {
	userID := ""
	if event.Member != nil && event.Member.User != nil {
		userID = event.Member.User.ID
	} else if event.User != nil {
		userID = event.User.ID
	}
	if owner := strings.TrimSpace(b.cfg.InstanceOwnerID); owner != "" && userID == owner {
		return true
	}
	return event.Member != nil && event.Member.Permissions&discordgo.PermissionAdministrator != 0
}
