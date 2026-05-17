package discord

import (
	"bytes"
	"context"
	"fmt"
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
	case commands.AutomationCommand:
		b.handleLeanAutomationSlashCommand(session, event, data)
	case commands.ReleasesCommand:
		b.handleReleasesSlashCommand(session, event, data)
	default:
		if groups, ok := commands.SkillCommandGroups[data.Name]; ok {
			b.handleSkillSlashCommand(session, event, data.Name, groups)
		}
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
		return b.automationChoices(commands.StringOption(data, "name")), true
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
	b.runAutomationFromSlash(session, event, commands.StringOption(data, "name"))
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

func (b *Bot) handleReleasesSlashCommand(session *discordgo.Session, event *discordgo.InteractionCreate, data discordgo.ApplicationCommandInteractionData) {
	start, end, label, err := releaseCalendarSpan(commands.StringOption(data, "span"), time.Now())
	if err != nil {
		b.respondEphemeral(session, event, err.Error())
		return
	}
	if err := session.InteractionRespond(event.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseDeferredChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{
			AllowedMentions: &discordgo.MessageAllowedMentions{},
		},
	}); err != nil {
		log.Printf("defer releases slash command failed: error=%v", err)
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), b.cfg.RunTimeout)
		defer cancel()
		imageData, itemCount, err := b.releaseCalendarPNG(ctx, start, end, label)
		if err != nil {
			log.Printf("render release calendar failed: error=%v", err)
			content := "Release-Kalender konnte nicht erstellt werden: " + err.Error()
			if _, editErr := session.InteractionResponseEdit(event.Interaction, &discordgo.WebhookEdit{
				Content:         &content,
				AllowedMentions: &discordgo.MessageAllowedMentions{},
			}); editErr != nil {
				log.Printf("edit releases failure response failed: error=%v", editErr)
			}
			return
		}
		content := fmt.Sprintf("Release-Kalender %s (%d Einträge)", label, itemCount)
		filename := "releases-" + start.Format("2006-01-02") + "-" + end.AddDate(0, 0, -1).Format("2006-01-02") + ".png"
		if _, err := session.InteractionResponseEdit(event.Interaction, &discordgo.WebhookEdit{
			Content: &content,
			Files: []*discordgo.File{{
				Name:        filename,
				ContentType: "image/png",
				Reader:      bytes.NewReader(imageData),
			}},
			AllowedMentions: &discordgo.MessageAllowedMentions{},
		}); err != nil {
			log.Printf("edit releases response failed: error=%v", err)
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
		b.respondEphemeral(session, event, "Ein Prompt ist erforderlich.")
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
		fallback := "Thread-Erstellung fehlgeschlagen. Bitte prüfe die Bot-Berechtigungen für Threads."
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
