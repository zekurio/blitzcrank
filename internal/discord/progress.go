package discord

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"blitzcrank/internal/agent"

	"github.com/bwmarrin/discordgo"
)

const discordProgressUpdateInterval = 1200 * time.Millisecond

type discordProgressReporter struct {
	bot        *Bot
	session    *discordgo.Session
	channelID  string
	replyToID  string
	messageID  string
	created    bool
	steps      []string
	lastUpdate time.Time
	mu         sync.Mutex

	interaction *discordgo.Interaction
}

func (b *Bot) newDiscordProgressReporter(session *discordgo.Session, channelID, replyToID string) *discordProgressReporter {
	return &discordProgressReporter{bot: b, session: session, channelID: strings.TrimSpace(channelID), replyToID: strings.TrimSpace(replyToID)}
}

func (b *Bot) newInteractionProgressReporter(session *discordgo.Session, interaction *discordgo.Interaction, channelID string) *discordProgressReporter {
	return &discordProgressReporter{bot: b, session: session, interaction: interaction, channelID: strings.TrimSpace(channelID), created: true}
}

func (r *discordProgressReporter) callback(ctx context.Context) func(agent.ProgressEvent) {
	return func(event agent.ProgressEvent) {
		r.update(ctx, event)
	}
}

func (r *discordProgressReporter) update(ctx context.Context, event agent.ProgressEvent) {
	if r == nil || r.bot == nil {
		return
	}
	line := discordProgressLine(event)
	if line == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.steps) == 0 || r.steps[len(r.steps)-1] != line {
		r.steps = append(r.steps, line)
		if len(r.steps) > 6 {
			r.steps = r.steps[len(r.steps)-6:]
		}
	}
	now := time.Now()
	if r.created && now.Sub(r.lastUpdate) < discordProgressUpdateInterval {
		return
	}
	r.lastUpdate = now
	r.postLocked(ctx, r.contentLocked())
}

func (r *discordProgressReporter) finish(ctx context.Context, content string) (*discordgo.Message, error) {
	if r == nil || r.bot == nil {
		return nil, nil
	}
	chunks := splitDiscordMessage(content)
	if len(chunks) == 0 {
		return nil, nil
	}
	r.mu.Lock()
	first, err := r.postLocked(ctx, chunks[0])
	r.mu.Unlock()
	if err != nil {
		return first, err
	}
	for _, chunk := range chunks[1:] {
		message, sendErr := r.bot.sendMessageReference(ctx, r.channelID, "", chunk)
		if first == nil {
			first = message
		}
		if sendErr != nil {
			return first, sendErr
		}
	}
	return first, nil
}

func (r *discordProgressReporter) postLocked(ctx context.Context, content string) (*discordgo.Message, error) {
	content = strings.TrimSpace(content)
	if content == "" {
		return nil, nil
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}
	if r.interaction != nil {
		edited, err := r.session.InteractionResponseEdit(r.interaction, &discordgo.WebhookEdit{
			Content:         &content,
			AllowedMentions: &discordgo.MessageAllowedMentions{},
		})
		if err != nil {
			log.Printf("edit discord progress response failed: error=%v", err)
			return nil, err
		}
		return edited, nil
	}
	if r.created && r.messageID != "" {
		message, err := r.session.ChannelMessageEditComplex(&discordgo.MessageEdit{
			ID:              r.messageID,
			Channel:         r.channelID,
			Content:         &content,
			AllowedMentions: &discordgo.MessageAllowedMentions{},
		})
		if err != nil {
			log.Printf("edit discord progress message failed: channel=%s message=%s error=%v", r.channelID, r.messageID, err)
		}
		return message, err
	}
	message, err := r.bot.sendMessageReference(ctx, r.channelID, r.replyToID, content)
	if err != nil {
		log.Printf("send discord progress message failed: channel=%s error=%v", r.channelID, err)
		return nil, err
	}
	if message != nil {
		r.created = true
		r.messageID = message.ID
	}
	return message, nil
}

func (r *discordProgressReporter) contentLocked() string {
	if len(r.steps) == 0 {
		return "Ich kümmere mich darum..."
	}
	lines := []string{"Ich kümmere mich darum..."}
	for _, step := range r.steps {
		lines = append(lines, "- "+step)
	}
	return strings.Join(lines, "\n")
}

func discordProgressLine(event agent.ProgressEvent) string {
	tool := strings.TrimSpace(event.ToolName)
	switch strings.TrimSpace(event.Phase) {
	case "start":
		return "Ich lese die Anfrage und lade den relevanten Kontext."
	case "model_start":
		if event.Iteration > 1 {
			return fmt.Sprintf("Ich werte die Tool-Ergebnisse aus, Durchgang %d.", event.Iteration)
		}
		return "Ich prüfe die Anfrage und wähle den nächsten Schritt."
	case "tools_selected":
		selection := germanCountPhrase(event.Count, "Tool-Aufruf", "Tool-Aufrufe")
		if event.Iteration > 0 {
			return fmt.Sprintf("Das Modell hat %s für Durchgang %d ausgewählt.", selection, event.Iteration)
		}
		return fmt.Sprintf("Das Modell hat %s ausgewählt.", selection)
	case "tool_start":
		if tool != "" {
			return fmt.Sprintf("Ich führe `%s` aus.", tool)
		}
		return "Ich führe ein Tool aus."
	case "approval_wait":
		if tool != "" {
			return fmt.Sprintf("Ich warte auf Freigabe für `%s`.", tool)
		}
		return "Ich warte auf Tool-Freigabe."
	case "approval_approved":
		if tool != "" {
			return fmt.Sprintf("Freigabe für `%s` erhalten.", tool)
		}
		return "Tool-Freigabe erhalten."
	case "approval_denied":
		if tool != "" {
			return fmt.Sprintf("Freigabe für `%s` abgelehnt; ich gebe das ans Modell zurück.", tool)
		}
		return "Tool-Freigabe abgelehnt; ich gebe das ans Modell zurück."
	case "tool_done":
		if tool != "" {
			return fmt.Sprintf("`%s` ist fertig.", tool)
		}
		return "Tool ist fertig."
	case "tool_error":
		if tool != "" {
			return fmt.Sprintf("`%s` hat einen Fehler zurückgegeben; ich versuche weiterzukommen.", tool)
		}
		return "Ein Tool hat einen Fehler zurückgegeben; ich versuche weiterzukommen."
	case "finalizing":
		return "Ich schreibe die finale Antwort."
	default:
		return strings.TrimSpace(event.Message)
	}
}
