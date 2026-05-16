package discord

import (
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode"

	"blitzcrank/internal/agent"
	"blitzcrank/internal/store"

	"github.com/bwmarrin/discordgo"
)

func (b *Bot) threadLock(threadID string) *sync.Mutex {
	value, _ := b.locks.LoadOrStore(threadID, &sync.Mutex{})
	return value.(*sync.Mutex)
}

func splitDiscordMessage(content string) []string {
	const limit = 1900
	content = strings.TrimSpace(content)
	if len(content) <= limit {
		return []string{content}
	}

	var chunks []string
	for len(content) > limit {
		cut := strings.LastIndex(content[:limit], "\n")
		if cut < 1 {
			cut = limit
		}
		chunks = append(chunks, strings.TrimSpace(content[:cut]))
		content = strings.TrimSpace(content[cut:])
	}
	if content != "" {
		chunks = append(chunks, content)
	}
	return chunks
}

func (b *Bot) mentionsBot(session *discordgo.Session, message *discordgo.Message) bool {
	if session == nil || message == nil {
		return false
	}
	botID := strings.TrimSpace(b.botID)
	if session.State != nil && session.State.User != nil {
		botID = session.State.User.ID
	}
	if botID == "" {
		return false
	}
	for _, user := range message.Mentions {
		if user != nil && user.ID == botID {
			return true
		}
	}
	return false
}

func discordThreadID(externalID string) string {
	return "discord:" + strings.TrimSpace(externalID)
}

func discordAuthor(user *discordgo.User) string {
	if user == nil {
		return "unknown Discord user"
	}
	name := strings.TrimSpace(user.Username)
	if user.GlobalName != "" {
		name = strings.TrimSpace(user.GlobalName)
	}
	if name == "" {
		name = user.ID
	}
	return fmt.Sprintf("%s (%s)", name, user.ID)
}

func threadTitle(content string) string {
	title := stripDiscordMentionTokens(content)
	title = strings.TrimSpace(title)
	title = strings.ReplaceAll(title, "\n", " ")
	title = strings.Join(strings.Fields(title), " ")
	title = strings.Trim(title, "`*_~|> ")
	if title == "" {
		return "Support request"
	}
	if len(title) > 90 {
		title = strings.TrimSpace(title[:90])
	}
	return title
}

func titleFromContent(content string) string {
	content = stripDiscordMentionTokens(content)
	content = strings.TrimSpace(content)
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			return line
		}
	}
	return "Support request"
}

func stripDiscordMentionTokens(content string) string {
	var kept []string
	for _, field := range strings.Fields(content) {
		if isDiscordMentionToken(field) {
			continue
		}
		kept = append(kept, field)
	}
	return strings.Join(kept, " ")
}

func isDiscordMentionToken(value string) bool {
	value = strings.Trim(value, ",.;:!?()[]{}")
	switch {
	case strings.HasPrefix(value, "<@") && strings.HasSuffix(value, ">"):
		return true
	case strings.HasPrefix(value, "<#") && strings.HasSuffix(value, ">"):
		return true
	case strings.HasPrefix(value, "<@&") && strings.HasSuffix(value, ">"):
		return true
	default:
		return false
	}
}

func isModelRuntimeQuestion(content string) bool {
	text := strings.ToLower(stripDiscordMentionTokens(content))
	text = strings.NewReplacer("ä", "ae", "ö", "oe", "ü", "ue", "ß", "ss").Replace(text)
	if !(strings.Contains(text, "model") || strings.Contains(text, "modell") || strings.Contains(text, "reasoning") || strings.Contains(text, "runtime")) {
		return false
	}
	questionSignals := []string{"which", "what", "using", "use", "verwend", "welch", "welches", "welchen", "gerade", "laeuf", "nutzt", "benutzt", "effort"}
	for _, signal := range questionSignals {
		if strings.Contains(text, signal) {
			return true
		}
	}
	return strings.Contains(text, "?")
}

func isToolInventoryQuestion(content string) bool {
	text := normalizeQuestionText(content)
	if text == "" {
		return false
	}
	hasToolWord := strings.Contains(text, "tool") || strings.Contains(text, "tools") || strings.Contains(text, "werkzeug") || strings.Contains(text, "werkzeuge")
	if !hasToolWord {
		return false
	}
	for _, signal := range []string{
		"welche", "welchen", "welches", "was", "what", "which", "list", "liste", "zaehle", "zaehl", "zähle", "zähl", "auffuehren", "aufführen", "anzeigen",
	} {
		if strings.Contains(text, signal) {
			return true
		}
	}
	return strings.Contains(text, "?")
}

func isOneOffDiscordQuestion(content string, triage agent.DiscordTriageResult) bool {
	if strings.TrimSpace(triage.Action) != "support_request" || !triage.Actionable || !triage.NeedsAgentRun {
		return false
	}
	text := normalizeQuestionText(content)
	if text == "" || !hasQuestionShape(text) {
		return false
	}
	if hasSupportCaseSignal(text) {
		return false
	}
	return hasAvailabilitySignal(text) || hasReleaseSignal(text)
}

func normalizeQuestionText(content string) string {
	text := strings.ToLower(stripDiscordMentionTokens(content))
	text = strings.NewReplacer("ä", "ae", "ö", "oe", "ü", "ue", "ß", "ss").Replace(text)
	var b strings.Builder
	lastSpace := false
	for _, r := range text {
		switch {
		case unicode.IsLetter(r), unicode.IsDigit(r), r == '?':
			b.WriteRune(r)
			lastSpace = false
		default:
			if !lastSpace {
				b.WriteByte(' ')
				lastSpace = true
			}
		}
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

func hasQuestionShape(text string) bool {
	if strings.Contains(text, "?") {
		return true
	}
	for _, signal := range []string{"ist ", "is ", "are ", "wann ", "when ", "where ", "wo ", "weisst ", "weißt ", "gibt es ", "gibts ", "kommt "} {
		if strings.HasPrefix(text, signal) || strings.Contains(text, " "+signal) {
			return true
		}
	}
	return false
}

func hasAvailabilitySignal(text string) bool {
	for _, signal := range []string{"auf jellyfin", "in jellyfin", "bei jellyfin", "jellyfin", "verfuegbar", "verfügbar", "available", "availability", "streaming", "watch"} {
		if strings.Contains(text, signal) {
			return true
		}
	}
	return false
}

func hasReleaseSignal(text string) bool {
	for _, signal := range []string{"wann kommt", "when does", "when is", "release", "released", "raus", "erscheint", "startet", "premiere"} {
		if strings.Contains(text, signal) {
			return true
		}
	}
	return false
}

func hasSupportCaseSignal(text string) bool {
	for _, signal := range []string{
		"geht nicht", "funktioniert nicht", "kaputt", "fehler", "problem", "bug", "fix", "reparier", "reparieren",
		"missing", "fehlt", "stuck", "haengt", "haengt fest", "failed", "error", "import", "download", "queue",
		"blocklist", "subtitle", "subtitles", "untertitel", "audio", "tonspur",
	} {
		if strings.Contains(text, signal) {
			return true
		}
	}
	return false
}

func looksGerman(content string) bool {
	text := strings.ToLower(stripDiscordMentionTokens(content))
	text = strings.NewReplacer("ä", "ae", "ö", "oe", "ü", "ue", "ß", "ss").Replace(text)
	germanSignals := []string{"welch", "verwend", "gerade", "kannst", "mir", "gehts", "geht's", "modell", "du ", "bitte", "werkzeug", "werkzeuge", "zaehl", "zaehle"}
	for _, signal := range germanSignals {
		if strings.Contains(text, signal) {
			return true
		}
	}
	return false
}

func fallbackIntakeReply(content, action string) string {
	german := looksGerman(content)
	switch action {
	case "unsupported":
		if german {
			return "Ich bin hier auf Medienserver-Support begrenzt."
		}
		return "I am limited to media-server support here."
	case "clarify":
		if german {
			return "Wobei genau brauchst du Hilfe?"
		}
		return "What do you need help with?"
	default:
		if german {
			return "Ich bin einsatzbereit."
		}
		return "I am ready."
	}
}

func toolInventoryReply(content string, available, issueOnly []string) string {
	if looksGerman(content) {
		reply := "In diesem Discord-Kontext kann ich diese Werkzeuge nutzen: " + inlineCodeList(available) + "."
		if len(issueOnly) > 0 {
			reply += "\n\nNur in Jellyseerr-Issue-Läufen mit Reparaturkontext sind zusätzlich verfügbar: " + inlineCodeList(issueOnly) + "."
		}
		return reply
	}
	reply := "In this Discord context I can use these tools: " + inlineCodeList(available) + "."
	if len(issueOnly) > 0 {
		reply += "\n\nOnly in Jellyseerr issue runs with repair context, these additional tools are available: " + inlineCodeList(issueOnly) + "."
	}
	return reply
}

func inlineCodeList(values []string) string {
	if len(values) == 0 {
		return "`none`"
	}
	quoted := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		quoted = append(quoted, "`"+value+"`")
	}
	if len(quoted) == 0 {
		return "`none`"
	}
	return strings.Join(quoted, ", ")
}

func validateDiscordReply(reply string) (string, error) {
	reply = strings.TrimSpace(reply)
	if reply == "" {
		return "", fmt.Errorf("discord reply is empty")
	}
	if len(reply) > 1900 {
		return "", fmt.Errorf("discord reply is too long: %d bytes", len(reply))
	}
	lower := strings.ToLower(reply)
	for _, marker := range []string{
		"webhook payload:",
		"tool result",
		"tool_results",
		"```json",
		"{\"",
		"api_key",
		"authorization:",
	} {
		if strings.Contains(lower, marker) {
			return "", fmt.Errorf("discord reply appears to expose internal output")
		}
	}
	return reply, nil
}

func safeDiscordFailureReply(content string) string {
	if looksGerman(content) {
		return "Ich konnte daraus keine sichere Antwort erstellen."
	}
	return "I could not produce a safe response for that request."
}

func emptySummary(summary string) string {
	summary = strings.TrimSpace(summary)
	if summary == "" {
		return "(none yet)"
	}
	return summary
}

func recentTranscript(events []store.AgentThreadEvent, limit int) string {
	if limit < 1 {
		limit = 12
	}
	start := len(events) - limit
	if start < 0 {
		start = 0
	}
	var lines []string
	for _, event := range events[start:] {
		message := strings.TrimSpace(event.Message)
		if message == "" {
			continue
		}
		actor := strings.TrimSpace(event.Actor)
		if actor == "" {
			actor = "unknown"
		}
		lines = append(lines, fmt.Sprintf("- %s at %s: %s", actor, event.CreatedAt.Format(time.RFC3339), message))
	}
	if len(lines) == 0 {
		return "(no prior messages)"
	}
	return strings.Join(lines, "\n")
}

func recentRuns(runs []store.AgentRun, limit int) string {
	if limit < 1 {
		limit = 5
	}
	start := len(runs) - limit
	if start < 0 {
		start = 0
	}
	var lines []string
	for _, run := range runs[start:] {
		status := strings.TrimSpace(run.CompletionReason)
		if status == "" {
			status = "completed"
		}
		reply := strings.TrimSpace(run.FinalResponse)
		if len(reply) > 240 {
			reply = strings.TrimSpace(reply[:240]) + "..."
		}
		if reply == "" {
			reply = strings.TrimSpace(run.Error)
		}
		if reply == "" {
			continue
		}
		lines = append(lines, fmt.Sprintf("- %s at %s: %s", status, run.StartedAt.Format(time.RFC3339), reply))
	}
	if len(lines) == 0 {
		return "(no prior agent outcomes)"
	}
	return strings.Join(lines, "\n")
}
