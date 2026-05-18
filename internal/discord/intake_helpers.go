package discord

import (
	"fmt"
	"strings"
	"unicode"

	"blitzcrank/internal/agent"
)

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

func isAutomationScheduleQuestion(content string) bool {
	text := normalizeQuestionText(content)
	if text == "" {
		return false
	}
	hasAutomationWord := strings.Contains(text, "automation") || strings.Contains(text, "automations") || strings.Contains(text, "job") || strings.Contains(text, "jobs") || strings.Contains(text, "schedule") || strings.Contains(text, "scheduled") || strings.Contains(text, "cron") || strings.Contains(text, "automatisierung") || strings.Contains(text, "automatisierungen")
	if !hasAutomationWord {
		return false
	}
	for _, signal := range []string{
		"when", "wann", "next", "naechst", "näch", "welche", "what", "which", "list", "liste", "zaehle", "zaehl", "zähle", "zähl", "laufen", "laeuft", "läuft", "run", "runs",
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
	return hasAvailabilitySignal(text) || hasReleaseSignal(text) || hasServiceStatusSignal(text)
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
	for _, signal := range []string{"ist ", "sind ", "is ", "are ", "wann ", "when ", "where ", "wo ", "weisst ", "weißt ", "gibt es ", "gibts ", "kommt "} {
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

func hasServiceStatusSignal(text string) bool {
	hasService := false
	for _, service := range []string{"jellyfin", "seerr", "sonarr", "radarr", "sabnzbd", "sab"} {
		if strings.Contains(text, service) {
			hasService = true
			break
		}
	}
	if !hasService {
		return false
	}
	for _, signal := range []string{"erreichbar", "online", "status", "laeuft", "läuft", "running", "reachable", "responding", "up", "down"} {
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
		"x-api-key",
		"x-emby-token",
		"seerr_api_key",
		"jellyfin_api_key",
		"sonarr_api_key",
		"radarr_api_key",
		"sabnzbd_api_key",
		"http://localhost",
		"https://localhost",
		"http://127.0.0.1",
		"https://127.0.0.1",
		"http://10.",
		"https://10.",
		"http://192.168.",
		"https://192.168.",
		"http://172.16.",
		"https://172.16.",
		"http://172.17.",
		"https://172.17.",
		"http://172.18.",
		"https://172.18.",
		"http://172.19.",
		"https://172.19.",
		"http://172.20.",
		"https://172.20.",
		"http://172.21.",
		"https://172.21.",
		"http://172.22.",
		"https://172.22.",
		"http://172.23.",
		"https://172.23.",
		"http://172.24.",
		"https://172.24.",
		"http://172.25.",
		"https://172.25.",
		"http://172.26.",
		"https://172.26.",
		"http://172.27.",
		"https://172.27.",
		"http://172.28.",
		"https://172.28.",
		"http://172.29.",
		"https://172.29.",
		"http://172.30.",
		"https://172.30.",
		"http://172.31.",
		"https://172.31.",
		"/api/v1/",
		"/api/v3/",
		"/var/",
		"/mnt/",
		"/home/",
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
