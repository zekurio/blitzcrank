package discord

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"blitzcrank/internal/agent"
	"blitzcrank/internal/config"
	"blitzcrank/internal/store"

	"github.com/bwmarrin/discordgo"
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

func TestDiscordThreadWritesJSONLTrace(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	state, err := store.Open(ctx, filepath.Join(dir, "blitzcrank.sqlite"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()

	bot := &Bot{
		cfg:   config.Config{ThreadsDirectory: filepath.Join(dir, "threads")},
		store: state,
	}
	event := &discordgo.MessageCreate{Message: &discordgo.Message{
		ID:        "message-1",
		ChannelID: "channel-1",
		GuildID:   "guild-1",
		Timestamp: time.Date(2026, 5, 16, 10, 0, 0, 0, time.UTC),
		Author:    &discordgo.User{ID: "user-1", Username: "alice"},
	}}
	if err := bot.recordDiscordThread(ctx, recordDiscordThreadRequest{
		ThreadID:      "thread-1",
		ParentID:      "channel-1",
		RootMessageID: "message-1",
		Title:         "Missing episode",
		Event:         event,
		EventType:     "root_message",
		Content:       "S02E05 fehlt",
	}); err != nil {
		t.Fatalf("recordDiscordThread() error = %v", err)
	}

	completedAt := time.Date(2026, 5, 16, 10, 1, 0, 0, time.UTC)
	bot.persistDiscordRun("discord:thread-1", store.AgentRun{
		ThreadID:         "discord:thread-1",
		SourceEventType:  "root_message",
		StartedAt:        completedAt.Add(-time.Minute),
		CompletedAt:      &completedAt,
		FinalResponse:    "Ist erledigt.",
		Posted:           true,
		Attribution:      "discord:gpt-5.5",
		CompletionReason: "discord response posted",
		Summary:          "Episode fixed.",
	})

	data, err := os.ReadFile(filepath.Join(dir, "threads", "discord", "thread-1.jsonl"))
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 3 {
		t.Fatalf("trace line count = %d, want 3\n%s", len(lines), string(data))
	}
	var records []map[string]any
	for _, line := range lines {
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("Unmarshal(%q) error = %v", line, err)
		}
		records = append(records, record)
	}
	if records[0]["type"] != "discord_thread" || records[1]["type"] != "discord_event" || records[2]["type"] != "discord_run" {
		t.Fatalf("trace record types = %#v", records)
	}
	if records[2]["final_response"] != "Ist erledigt." || records[2]["posted"] != true {
		t.Fatalf("run trace = %#v", records[2])
	}
	loaded, ok, err := state.LoadAgentThreadByExternalID(ctx, "discord", "thread-1")
	if err != nil {
		t.Fatalf("LoadAgentThreadByExternalID() error = %v", err)
	}
	if !ok {
		t.Fatal("LoadAgentThreadByExternalID() ok = false")
	}
	if loaded.ThreadID != records[0]["thread_id"] || loaded.ExternalID != records[0]["discord_thread_id"] {
		t.Fatalf("thread DB/JSONL mismatch: loaded=%#v trace=%#v", loaded, records[0])
	}
	if len(loaded.Events) != 1 || loaded.Events[0].ExternalMessageID != records[1]["external_message_id"] {
		t.Fatalf("event DB/JSONL mismatch: loaded=%#v trace=%#v", loaded.Events, records[1])
	}
	if loaded.Summary != "Episode fixed." {
		t.Fatalf("thread summary = %q", loaded.Summary)
	}
	if len(loaded.Runs) != 1 || loaded.Runs[0].FinalResponse != records[2]["final_response"] {
		t.Fatalf("run DB/JSONL mismatch: loaded=%#v trace=%#v", loaded.Runs, records[2])
	}
}

func TestDiscordDirectInteractionWritesJSONLTrace(t *testing.T) {
	dir := t.TempDir()
	bot := &Bot{cfg: config.Config{ThreadsDirectory: filepath.Join(dir, "threads")}}
	event := &discordgo.MessageCreate{Message: &discordgo.Message{
		ID:        "message-1",
		ChannelID: "channel-1",
		GuildID:   "guild-1",
		Timestamp: time.Date(2026, 5, 16, 10, 0, 0, 0, time.UTC),
		Author:    &discordgo.User{ID: "user-1", Username: "alice"},
	}}
	startedAt := time.Date(2026, 5, 16, 10, 1, 0, 0, time.UTC)
	bot.appendDiscordInteractionTrace(event, "direct_agent_reply", "ping", "pong", "", startedAt, startedAt.Add(time.Second), map[string]any{
		"attribution": "discord:gpt-5.5",
	})

	data, err := os.ReadFile(filepath.Join(dir, "threads", "discord", "interactions", "message-1.jsonl"))
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	var record map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(data))), &record); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if record["type"] != "discord_interaction" || record["interaction_type"] != "direct_agent_reply" {
		t.Fatalf("interaction trace = %#v", record)
	}
	if record["message_id"] != "message-1" || record["reply"] != "pong" || record["attribution"] != "discord:gpt-5.5" {
		t.Fatalf("interaction trace = %#v", record)
	}
}

func TestDiscordAutomationReportWritesJSONLOnly(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	state, err := store.Open(ctx, filepath.Join(dir, "blitzcrank.sqlite"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer state.Close()

	bot := &Bot{
		cfg:   config.Config{ThreadsDirectory: filepath.Join(dir, "threads"), BotPublicName: "Blitzcrank"},
		store: state,
	}
	bot.recordAutomationReport(ctx, "hourly-stale-import-handler", "done")

	data, err := os.ReadFile(filepath.Join(dir, "threads", "automations", "hourly-stale-import-handler.jsonl"))
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	var record map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(data))), &record); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if record["type"] != "discord_automation_report" || record["message"] != "done" {
		t.Fatalf("automation report trace = %#v", record)
	}
	events, err := state.LoadAgentThreadEvents(ctx, "discord_automation:hourly-stale-import-handler")
	if err != nil {
		t.Fatalf("LoadAgentThreadEvents() error = %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("automation report events = %#v, want none", events)
	}
}
