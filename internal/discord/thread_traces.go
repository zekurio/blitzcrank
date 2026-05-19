package discord

import (
	"log"
	"path/filepath"
	"strings"
	"time"

	discordevents "blitzcrank/internal/discord/events"
	"blitzcrank/internal/runtimectx"
	"blitzcrank/internal/store"

	"github.com/bwmarrin/discordgo"
)

type discordInteractionTraceRequest struct {
	Event           *discordgo.MessageCreate
	InteractionType string
	Content         string
	Reply           string
	ErrorText       string
	StartedAt       time.Time
	CompletedAt     time.Time
	Extra           map[string]any
}

func (b *Bot) appendDiscordTrace(threadID string, value any) {
	if strings.TrimSpace(b.cfg.ThreadsDirectory) == "" {
		return
	}
	if err := store.AppendJSONL(filepath.Join(b.cfg.ThreadsDirectory, "discord", discordTraceID(threadID)+".jsonl"), value); err != nil {
		log.Printf("append discord trace %s: %v", threadID, err)
	}
}

func (b *Bot) recordDiscordPromptCompactions(threadID string, entries []runtimectx.CompactionEntry) {
	if strings.TrimSpace(b.cfg.ThreadsDirectory) == "" || len(entries) == 0 {
		return
	}
	ledgerPath := filepath.Join(b.cfg.ThreadsDirectory, "discord", discordTraceID(threadID)+".compactions.jsonl")
	if err := runtimectx.AppendCompactionEntries(ledgerPath, entries); err != nil {
		log.Printf("append discord compaction ledger %s: %v", threadID, err)
		return
	}
	for _, entry := range entries {
		b.appendDiscordTrace(threadID, map[string]any{
			"type":                 "context_compaction",
			"thread_id":            threadID,
			"entry_id":             entry.ID,
			"summary":              entry.Summary,
			"first_kept_entry_id":  entry.FirstKeptEntryID,
			"tokens_before":        entry.TokensBefore,
			"compaction_timestamp": entry.Timestamp,
			"details":              entry.Details,
		})
	}
}

func (b *Bot) appendAutomationTrace(automationName string, value any) {
	if strings.TrimSpace(b.cfg.ThreadsDirectory) == "" {
		return
	}
	if err := store.AppendJSONL(filepath.Join(b.cfg.ThreadsDirectory, "automations", discordTraceID(automationName)+".jsonl"), value); err != nil {
		log.Printf("append automation trace %s: %v", automationName, err)
	}
}

func (b *Bot) appendDiscordInteractionTrace(request discordInteractionTraceRequest) {
	event := request.Event
	if event == nil || strings.TrimSpace(b.cfg.ThreadsDirectory) == "" {
		return
	}
	payload := map[string]any{
		"type":             "discord_interaction",
		"interaction_type": request.InteractionType,
		"content":          request.Content,
		"reply":            request.Reply,
		"started_at":       request.StartedAt.Format(time.RFC3339Nano),
		"completed_at":     request.CompletedAt.Format(time.RFC3339Nano),
	}
	if request.ErrorText != "" {
		payload["error"] = request.ErrorText
	}
	for key, value := range discordevents.MessagePayload(event, "") {
		payload[key] = value
	}
	for key, value := range request.Extra {
		payload[key] = value
	}
	traceID := discordTraceID(event.ID)
	if traceID == "unknown" {
		traceID = discordTraceID(event.ChannelID)
	}
	if err := store.AppendJSONL(filepath.Join(b.cfg.ThreadsDirectory, "discord", "interactions", traceID+".jsonl"), payload); err != nil {
		log.Printf("append discord interaction trace %s: %v", traceID, err)
	}
}

func discordTraceID(threadID string) string {
	traceID := strings.TrimPrefix(threadID, "discord:")
	traceID = strings.TrimSpace(traceID)
	if traceID == "" {
		return "unknown"
	}
	return strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', ':':
			return '-'
		default:
			return r
		}
	}, traceID)
}

func formatOptionalTime(value *time.Time) string {
	if value == nil {
		return ""
	}
	return value.Format(time.RFC3339Nano)
}
