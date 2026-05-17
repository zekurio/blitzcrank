package discord

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"blitzcrank/internal/store"

	"github.com/bwmarrin/discordgo"
)

const (
	feedbackButtonCustomIDPrefix = "blitz_feedback_text:"
	feedbackModalCustomIDPrefix  = "blitz_feedback_modal:"
	feedbackTextInputCustomID    = "feedback"
)

type discordFeedbackRecord struct {
	ChannelID string
	MessageID string
	Rating    string
	Text      string
	Source    string
	Actor     string
	ActorID   string
	CreatedAt time.Time
}

func (b *Bot) addFeedbackButton(ctx context.Context, channelID, messageID string) {
	if b.session == nil || strings.TrimSpace(channelID) == "" || strings.TrimSpace(messageID) == "" {
		return
	}
	select {
	case <-ctx.Done():
		return
	default:
	}
	components := []discordgo.MessageComponent{
		discordgo.ActionsRow{
			Components: []discordgo.MessageComponent{
				discordgo.Button{
					Label:    "Feedback",
					Style:    discordgo.SecondaryButton,
					CustomID: feedbackButtonCustomID(channelID, messageID),
				},
			},
		},
	}
	if _, err := b.session.ChannelMessageEditComplex(&discordgo.MessageEdit{
		ID:         messageID,
		Channel:    channelID,
		Components: &components,
	}); err != nil {
		log.Printf("add feedback button failed: message=%s error=%v", messageID, err)
	}
}

func (b *Bot) handleFeedbackReaction(event *discordgo.MessageReactionAdd) {
	rating, handled := feedbackReaction(&event.Emoji)
	if !handled {
		return
	}
	channelID := strings.TrimSpace(event.ChannelID)
	messageID := strings.TrimSpace(event.MessageID)
	b.recordDiscordFeedback(context.Background(), discordFeedbackRecord{
		ChannelID: channelID,
		MessageID: messageID,
		Rating:    rating,
		Source:    "reaction",
		Actor:     approvalActor(event),
		ActorID:   strings.TrimSpace(event.UserID),
		CreatedAt: time.Now().UTC(),
	})
	b.addFeedbackButton(context.Background(), channelID, messageID)
}

func (b *Bot) handleFeedbackComponent(session *discordgo.Session, event *discordgo.InteractionCreate) bool {
	if event == nil || event.Interaction == nil || event.Type != discordgo.InteractionMessageComponent {
		return false
	}
	data := event.MessageComponentData()
	channelID, messageID, ok := parseFeedbackCustomID(data.CustomID, feedbackButtonCustomIDPrefix)
	if !ok {
		return false
	}
	if strings.TrimSpace(channelID) == "" && event.Message != nil {
		channelID = event.Message.ChannelID
	}
	if strings.TrimSpace(messageID) == "" && event.Message != nil {
		messageID = event.Message.ID
	}
	if err := session.InteractionRespond(event.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseModal,
		Data: &discordgo.InteractionResponseData{
			CustomID: feedbackModalCustomID(channelID, messageID),
			Title:    "Feedback fuer Blitzcrank",
			Components: []discordgo.MessageComponent{
				discordgo.ActionsRow{
					Components: []discordgo.MessageComponent{
						discordgo.TextInput{
							CustomID:    feedbackTextInputCustomID,
							Label:       "Was soll geaendert oder geprueft werden?",
							Style:       discordgo.TextInputParagraph,
							Placeholder: "Kurz beschreiben, was falsch oder hilfreich war.",
							Required:    true,
							MinLength:   3,
							MaxLength:   1500,
						},
					},
				},
			},
		},
	}); err != nil {
		log.Printf("open feedback modal failed: message=%s error=%v", messageID, err)
	}
	return true
}

func (b *Bot) handleFeedbackModal(session *discordgo.Session, event *discordgo.InteractionCreate) bool {
	if event == nil || event.Interaction == nil || event.Type != discordgo.InteractionModalSubmit {
		return false
	}
	data := event.ModalSubmitData()
	channelID, messageID, ok := parseFeedbackCustomID(data.CustomID, feedbackModalCustomIDPrefix)
	if !ok {
		return false
	}
	text := strings.TrimSpace(modalTextInputValue(data.Components, feedbackTextInputCustomID))
	if text == "" {
		b.respondEphemeral(session, event, "Feedback text is required.")
		return true
	}
	b.recordDiscordFeedback(context.Background(), discordFeedbackRecord{
		ChannelID: strings.TrimSpace(channelID),
		MessageID: strings.TrimSpace(messageID),
		Text:      text,
		Source:    "modal",
		Actor:     interactionAuthor(event),
		ActorID:   interactionUserID(event),
		CreatedAt: time.Now().UTC(),
	})
	b.respondEphemeral(session, event, "Feedback gespeichert. Danke.")
	return true
}

func (b *Bot) recordDiscordFeedback(ctx context.Context, record discordFeedbackRecord) {
	record.ChannelID = strings.TrimSpace(record.ChannelID)
	record.MessageID = strings.TrimSpace(record.MessageID)
	record.Rating = strings.TrimSpace(record.Rating)
	record.Text = strings.TrimSpace(record.Text)
	record.Source = strings.TrimSpace(record.Source)
	if record.CreatedAt.IsZero() {
		record.CreatedAt = time.Now().UTC()
	}

	thread, ok := b.feedbackThread(ctx, record.ChannelID, record.MessageID)
	if b.store != nil && ok {
		record = b.mergeExistingDiscordFeedback(ctx, thread.ThreadID, record)
	}
	payload := map[string]any{
		"type":       "discord_feedback",
		"source":     record.Source,
		"rating":     record.Rating,
		"text":       record.Text,
		"actor":      record.Actor,
		"actor_id":   record.ActorID,
		"channel_id": record.ChannelID,
		"message_id": record.MessageID,
		"created_at": record.CreatedAt.Format(time.RFC3339Nano),
	}
	if ok {
		payload["thread_id"] = thread.ThreadID
	}
	if b.store != nil && ok {
		data, _ := json.Marshal(payload)
		event := store.AgentThreadEvent{
			ThreadID:          thread.ThreadID,
			EventType:         "feedback",
			Actor:             record.Actor,
			ActorID:           record.ActorID,
			Message:           feedbackEventMessage(record),
			ExternalMessageID: record.MessageID,
			PayloadJSON:       string(data),
			CreatedAt:         record.CreatedAt,
		}
		existing, found, err := b.store.LoadLatestAgentThreadFeedbackEvent(ctx, thread.ThreadID, record.MessageID, record.ActorID)
		if err != nil {
			log.Printf("load discord feedback event failed: thread=%s message=%s error=%v", thread.ThreadID, record.MessageID, err)
		} else if found {
			event.ID = existing.ID
			if !existing.CreatedAt.IsZero() {
				event.CreatedAt = existing.CreatedAt
			}
			if err := b.store.UpdateAgentThreadEvent(ctx, event); err != nil {
				log.Printf("update discord feedback event failed: thread=%s message=%s error=%v", thread.ThreadID, record.MessageID, err)
			}
		} else if err := b.store.InsertAgentThreadEvent(ctx, event); err != nil {
			log.Printf("record discord feedback event failed: thread=%s message=%s error=%v", thread.ThreadID, record.MessageID, err)
		}
	}
	if ok {
		b.upsertDiscordTrace(thread.ThreadID, record, payload)
		return
	}
	b.upsertDiscordFeedbackTrace(record, payload)
}

func (b *Bot) mergeExistingDiscordFeedback(ctx context.Context, threadID string, record discordFeedbackRecord) discordFeedbackRecord {
	if b.store == nil || strings.TrimSpace(record.ActorID) == "" {
		return record
	}
	existing, ok, err := b.store.LoadLatestAgentThreadFeedbackEvent(ctx, threadID, record.MessageID, record.ActorID)
	if err != nil {
		log.Printf("load prior discord feedback failed: thread=%s message=%s error=%v", threadID, record.MessageID, err)
		return record
	}
	if !ok {
		return record
	}
	var prior struct {
		Source    string `json:"source"`
		Rating    string `json:"rating"`
		Text      string `json:"text"`
		Actor     string `json:"actor"`
		ActorID   string `json:"actor_id"`
		ChannelID string `json:"channel_id"`
		CreatedAt string `json:"created_at"`
	}
	if err := json.Unmarshal([]byte(existing.PayloadJSON), &prior); err != nil {
		return record
	}
	if record.Rating == "" {
		record.Rating = strings.TrimSpace(prior.Rating)
	}
	if record.Text == "" {
		record.Text = strings.TrimSpace(prior.Text)
	}
	if record.Actor == "" {
		record.Actor = strings.TrimSpace(prior.Actor)
	}
	if record.ActorID == "" {
		record.ActorID = strings.TrimSpace(prior.ActorID)
	}
	if record.ChannelID == "" {
		record.ChannelID = strings.TrimSpace(prior.ChannelID)
	}
	if strings.TrimSpace(prior.Source) == "reaction" && record.Source == "modal" {
		record.Source = "reaction"
	}
	if !existing.CreatedAt.IsZero() {
		record.CreatedAt = existing.CreatedAt
	}
	return record
}

func (b *Bot) feedbackThread(ctx context.Context, channelID, messageID string) (store.AgentThread, bool) {
	if b.store == nil {
		return store.AgentThread{}, false
	}
	for _, externalID := range []string{messageID, channelID} {
		if strings.TrimSpace(externalID) == "" {
			continue
		}
		thread, ok, err := b.store.LoadAgentThreadByExternalID(ctx, "discord", externalID)
		if err != nil {
			log.Printf("load discord feedback thread failed: external=%s error=%v", externalID, err)
			continue
		}
		if ok {
			return thread, true
		}
	}
	return store.AgentThread{}, false
}

func (b *Bot) upsertDiscordTrace(threadID string, record discordFeedbackRecord, payload map[string]any) {
	if strings.TrimSpace(b.cfg.ThreadsDirectory) == "" {
		return
	}
	path := filepath.Join(b.cfg.ThreadsDirectory, "discord", discordTraceID(threadID)+".jsonl")
	if err := upsertFeedbackJSONL(path, record, payload); err != nil {
		log.Printf("upsert discord feedback trace %s: %v", threadID, err)
	}
}

func (b *Bot) upsertDiscordFeedbackTrace(record discordFeedbackRecord, payload map[string]any) {
	if strings.TrimSpace(b.cfg.ThreadsDirectory) == "" {
		return
	}
	traceID := discordTraceID(record.MessageID)
	if traceID == "unknown" {
		traceID = discordTraceID(record.ChannelID)
	}
	if err := upsertFeedbackJSONL(filepath.Join(b.cfg.ThreadsDirectory, "discord", "feedback", traceID+".jsonl"), record, payload); err != nil {
		log.Printf("upsert discord feedback trace %s: %v", traceID, err)
	}
}

func upsertFeedbackJSONL(path string, record discordFeedbackRecord, payload map[string]any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if strings.TrimSpace(path) == "" {
		return nil
	}
	content, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return store.AppendJSONL(path, payload)
		}
		return err
	}
	trimmed := strings.TrimRight(string(content), "\n")
	var lines []string
	if strings.TrimSpace(trimmed) != "" {
		lines = strings.Split(trimmed, "\n")
	}
	replaced := false
	for index, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var existing map[string]any
		if err := json.Unmarshal([]byte(line), &existing); err != nil {
			continue
		}
		if existing["type"] == "discord_feedback" &&
			strings.TrimSpace(valueString(existing["message_id"])) == record.MessageID &&
			strings.TrimSpace(valueString(existing["actor_id"])) == record.ActorID {
			lines[index] = string(data)
			replaced = true
			break
		}
	}
	if !replaced {
		lines = append(lines, string(data))
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644)
}
