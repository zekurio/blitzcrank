package discord

import (
	"context"
	"log"
	"strings"

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
	case commands.AutomationCommand:
		b.handleLeanAutomationSlashCommand(session, event, data)
	}
}

func (b *Bot) handleAutocomplete(session *discordgo.Session, event *discordgo.InteractionCreate) {
	data := event.ApplicationCommandData()
	choices, ok := b.autocompleteChoices(data)
	if !ok {
		return
	}
	if err := session.InteractionRespond(event.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionApplicationCommandAutocompleteResult,
		Data: &discordgo.InteractionResponseData{Choices: choices},
	}); err != nil {
		log.Printf("send autocomplete response failed: command=%s error=%v", data.Name, err)
	}
}

func (b *Bot) autocompleteChoices(data discordgo.ApplicationCommandInteractionData) ([]*discordgo.ApplicationCommandOptionChoice, bool) {
	switch data.Name {
	case commands.AutomationCommand:
		return b.automationChoices(commands.AutomationName(data)), true
	default:
		return nil, false
	}
}

func (b *Bot) handleLeanAutomationSlashCommand(session *discordgo.Session, event *discordgo.InteractionCreate, data discordgo.ApplicationCommandInteractionData) {
	if !b.isAdminInteraction(event) {
		b.respondEphemeral(session, event, "Nur der konfigurierte Owner oder Discord-Administratoren können diesen Befehl verwenden.")
		return
	}
	if b.runtime == nil {
		b.respondEphemeral(session, event, "Der Laufzeitmanager ist noch nicht bereit.")
		return
	}
	b.runAutomationFromSlash(session, event, commands.AutomationName(data))
}

func (b *Bot) runAutomationFromSlash(session *discordgo.Session, event *discordgo.InteractionCreate, name string) {
	name = strings.TrimSpace(name)
	if name == "" {
		b.respondEphemeral(session, event, "Der Name der Automatisierung ist erforderlich.")
		return
	}
	b.respondEphemeral(session, event, "Automatisierung `"+name+"` wird ausgeführt.")
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
	if b.memberHasAdminRole(event.Member) {
		return true
	}
	return event.Member != nil && event.Member.Permissions&discordgo.PermissionAdministrator != 0
}
