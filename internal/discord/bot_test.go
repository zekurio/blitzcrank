package discord

import (
	"strings"
	"testing"
	"time"

	"blitzcrank/internal/agent"
	"blitzcrank/internal/store"
)

func TestThreadTitleCompactsAndLimitsContent(t *testing.T) {
	title := threadTitle("  **Missing\n\n episode   for a very long series title that should be shortened before Discord sees it because the API has a strict limit**  ")
	if strings.Contains(title, "\n") {
		t.Fatalf("threadTitle() contains newline: %q", title)
	}
	if len(title) > 90 {
		t.Fatalf("threadTitle() length = %d, want <= 90", len(title))
	}
	if title == "" || title == "Support request" {
		t.Fatalf("threadTitle() = %q, want content-derived title", title)
	}
}

func TestThreadTitleStripsDiscordMentions(t *testing.T) {
	title := threadTitle("<@1503832472671223930> Missing S02E05?")
	if title != "Missing S02E05?" {
		t.Fatalf("threadTitle() = %q", title)
	}
}

func TestModelRuntimeQuestionDetection(t *testing.T) {
	tests := []string{
		"<@1503832472671223930> welches model verwendest du gerade?",
		"which model are you using?",
		"what reasoning effort are you running?",
	}
	for _, tt := range tests {
		if !isModelRuntimeQuestion(tt) {
			t.Fatalf("isModelRuntimeQuestion(%q) = false", tt)
		}
	}
	if isModelRuntimeQuestion("Kannst du mir mit Mathe helfen?") {
		t.Fatal("isModelRuntimeQuestion(math question) = true")
	}
}

func TestToolInventoryQuestionDetection(t *testing.T) {
	tests := []string{
		"<@1503832472671223930> Welche tools kannst du nutzen?",
		"bitte zähle alle werkzeuge auf.",
		"please list all tools",
	}
	for _, tt := range tests {
		if !isToolInventoryQuestion(tt) {
			t.Fatalf("isToolInventoryQuestion(%q) = false", tt)
		}
	}
	if isToolInventoryQuestion("Kannst du Project Hail Mary suchen?") {
		t.Fatal("isToolInventoryQuestion(media request) = true")
	}
}

func TestAutomationScheduleQuestionDetection(t *testing.T) {
	tests := []string{
		"<@1503832472671223930> wann läuft der nächste automation job?",
		"which scheduled jobs are configured?",
		"please list automations",
	}
	for _, tt := range tests {
		if !isAutomationScheduleQuestion(tt) {
			t.Fatalf("isAutomationScheduleQuestion(%q) = false", tt)
		}
	}
	if isAutomationScheduleQuestion("Kannst du Project Hail Mary suchen?") {
		t.Fatal("isAutomationScheduleQuestion(media request) = true")
	}
}

func TestFallbackIntakeReply(t *testing.T) {
	reply := fallbackIntakeReply("Kannst du mir mit Mathe helfen?", "unsupported")
	if !strings.Contains(reply, "Medienserver") {
		t.Fatalf("fallbackIntakeReply() = %q", reply)
	}
	reply = fallbackIntakeReply("Can you help?", "clarify")
	if !strings.Contains(reply, "What") {
		t.Fatalf("fallbackIntakeReply(clarify) = %q", reply)
	}
}

func TestValidateDiscordReplyRejectsInternalOutput(t *testing.T) {
	if _, err := validateDiscordReply("Alles gut."); err != nil {
		t.Fatalf("validateDiscordReply() error = %v", err)
	}
	if _, err := validateDiscordReply("tool result: {\"secret\":true}"); err == nil {
		t.Fatal("validateDiscordReply() error = nil, want internal-output error")
	}
}

func TestOneOffDiscordQuestionRouting(t *testing.T) {
	triage := agent.DiscordTriageResult{Action: "support_request", Actionable: true, NeedsAgentRun: true}
	tests := []struct {
		name    string
		message string
		want    bool
	}{
		{name: "jellyfin availability", message: "ist auf jellyfin der neue project hail mary film verfügbar?", want: true},
		{name: "release date", message: "weiß jemand wann der neue ghost in the shell anime rauskommt?", want: true},
		{name: "playback issue", message: "Project Hail Mary geht in Jellyfin nicht"},
		{name: "missing track", message: "bei S02E05 fehlen die Untertitel"},
		{name: "download issue", message: "download stuck for Ghost in the Shell"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isOneOffDiscordQuestion(tt.message, triage); got != tt.want {
				t.Fatalf("isOneOffDiscordQuestion() = %t, want %t", got, tt.want)
			}
		})
	}
}

func TestRecentTranscriptUsesLatestMessages(t *testing.T) {
	now := time.Date(2026, 5, 16, 10, 0, 0, 0, time.UTC)
	events := []store.AgentThreadEvent{
		{Actor: "alice", Message: "old", CreatedAt: now},
		{Actor: "bob", Message: "new", CreatedAt: now.Add(time.Minute)},
	}
	transcript := recentTranscript(events, 1)
	if strings.Contains(transcript, "old") || !strings.Contains(transcript, "new") {
		t.Fatalf("recentTranscript() = %q", transcript)
	}
}

func TestRecentRunsIncludesOutcomeWithoutRawEmptyRows(t *testing.T) {
	now := time.Date(2026, 5, 16, 10, 0, 0, 0, time.UTC)
	runs := []store.AgentRun{
		{StartedAt: now, CompletionReason: "discord response posted", FinalResponse: "fixed"},
	}
	out := recentRuns(runs, 5)
	if !strings.Contains(out, "fixed") || !strings.Contains(out, "discord response posted") {
		t.Fatalf("recentRuns() = %q", out)
	}
}
