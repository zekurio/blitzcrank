package discord

import (
	"context"
	"encoding/json"
	"log"
	"strings"
	"time"

	"blitzcrank/internal/store"

	"github.com/bwmarrin/discordgo"
)

func (b *Bot) handleAutomationThreadMessage(session *discordgo.Session, event *discordgo.MessageCreate, content string) bool {
	thread, ok := b.automationThread(context.Background(), event.ChannelID)
	if !ok {
		return false
	}
	if !b.automationInstructionAllowed(event) {
		log.Printf("ignored non-admin user message in automation thread: thread=%s message=%s author=%s", event.ChannelID, event.ID, discordUserID(event.Author))
		return true
	}
	if b.runtime == nil {
		log.Printf("ignored automation instruction without runtime manager: automation=%s thread=%s message=%s", thread.ExternalID, event.ChannelID, event.ID)
		return true
	}
	b.recordAutomationInstructionMessage(context.Background(), thread, event, content)
	go b.runAutomationInstruction(context.Background(), session, thread, event, content)
	return true
}

func (b *Bot) automationThread(ctx context.Context, channelID string) (store.AgentThread, bool) {
	if b.store == nil {
		return store.AgentThread{}, false
	}
	thread, ok, err := b.store.LoadAgentThreadByRootExternalID(ctx, "discord_automation", channelID)
	if err != nil {
		log.Printf("load automation thread failed: thread=%s error=%v", channelID, err)
		return store.AgentThread{}, false
	}
	return thread, ok
}

func (b *Bot) automationInstructionAllowed(event *discordgo.MessageCreate) bool {
	_, isAdmin, _ := b.discordRequestSecurity(event)
	return isAdmin
}

func (b *Bot) recordAutomationInstructionMessage(ctx context.Context, thread store.AgentThread, event *discordgo.MessageCreate, content string) {
	automationName := strings.TrimSpace(thread.ExternalID)
	author := discordAuthor(event.Author)
	authorID := discordUserID(event.Author)
	payload := map[string]any{
		"message":    content,
		"message_id": event.ID,
		"channel_id": event.ChannelID,
	}
	payloadJSON, _ := json.Marshal(payload)
	if b.store != nil {
		if err := b.store.InsertAgentThreadEvent(ctx, store.AgentThreadEvent{
			ThreadID:          thread.ThreadID,
			EventType:         "automation_instruction",
			Actor:             author,
			ActorID:           authorID,
			ExternalMessageID: event.ID,
			PayloadJSON:       string(payloadJSON),
			CreatedAt:         time.Now().UTC(),
		}); err != nil {
			log.Printf("record automation instruction event failed: automation=%s message=%s error=%v", automationName, event.ID, err)
		}
	}
}

func (b *Bot) runAutomationInstruction(ctx context.Context, session *discordgo.Session, thread store.AgentThread, event *discordgo.MessageCreate, content string) {
	automationName := strings.TrimSpace(thread.ExternalID)
	if automationName == "" {
		log.Printf("automation instruction missing automation name: thread=%s message=%s", thread.ThreadID, event.ID)
		return
	}
	if session != nil {
		if err := session.ChannelTyping(event.ChannelID); err != nil {
			log.Printf("send automation typing indicator: %v", err)
		}
	}
	if b.session != nil {
		if _, err := b.sendMessageReference(ctx, event.ChannelID, event.ID, "Verstanden. Ich starte diese Automation mit deiner zusätzlichen Anweisung."); err != nil {
			log.Printf("send automation instruction acknowledgement failed: automation=%s message=%s error=%v", automationName, event.ID, err)
		}
	}
	if err := b.runtime.RunAutomationWithInstruction(ctx, automationName, content, discordAuthor(event.Author), discordUserID(event.Author)); err != nil {
		log.Printf("run automation instruction failed: automation=%s message=%s error=%v", automationName, event.ID, err)
		if b.session != nil {
			if _, sendErr := b.sendMessageReference(context.Background(), event.ChannelID, event.ID, "Ich konnte die Automation nicht starten. Bitte prüfe die Bot-Logs."); sendErr != nil {
				log.Printf("send automation instruction failure failed: automation=%s message=%s error=%v", automationName, event.ID, sendErr)
			}
		}
	}
}
