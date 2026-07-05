package discord

import (
	"errors"
	"strings"
	"testing"

	"blitzcrank/internal/automation"

	"github.com/bwmarrin/discordgo"
)

func TestClassifyAutomationResponse(t *testing.T) {
	tests := []struct {
		name     string
		response string
		want     automationRunStatus
	}{
		{"plain success", "Alles in Ordnung.", automationRunOK},
		{"explicit failure keyword", "Der Import ist fehlgeschlagen.", automationRunError},
		{"timeout keyword", "Timeout beim Sonarr-Aufruf.", automationRunError},
		// known false positive: substring match on "fehler" fires even though
		// this sentence reports a healthy, error-free run.
		{"false positive: no errors found", "Keine Fehler gefunden.", automationRunError},
		{"manual review requested", "Bitte manuell prüfen: Eintrag X.", automationRunWarning},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := classifyAutomationResponse(tt.response); got != tt.want {
				t.Errorf("classifyAutomationResponse(%q) = %v, want %v", tt.response, got, tt.want)
			}
		})
	}
}

func TestAutomationCompletedEmbed(t *testing.T) {
	t.Run("run error takes precedence", func(t *testing.T) {
		embed := automationCompletedEmbed(automation.Task{}, "", errors.New("boom"), nil)
		if embed == nil {
			t.Fatal("expected non-nil embed")
		}
		if !strings.HasPrefix(embed.Title, "❌") {
			t.Errorf("title = %q, want prefix ❌", embed.Title)
		}
		if !strings.Contains(embed.Description, "Konnte nicht ausgeführt werden") {
			t.Errorf("description = %q, want to contain %q", embed.Description, "Konnte nicht ausgeführt werden")
		}
	})

	t.Run("tool failures with response", func(t *testing.T) {
		failures := []automation.ToolFailure{{Tool: "sonarr", Error: "connection refused"}}
		embed := automationCompletedEmbed(automation.Task{}, "Alles gut gelaufen.", nil, failures)
		if embed == nil {
			t.Fatal("expected non-nil embed")
		}
		if !strings.Contains(embed.Title, "Tool-Fehler") {
			t.Errorf("title = %q, want to contain %q", embed.Title, "Tool-Fehler")
		}
		if !strings.HasPrefix(embed.Description, "**Kurzfassung:**") {
			t.Errorf("description = %q, want prefix %q", embed.Description, "**Kurzfassung:**")
		}
	})

	t.Run("empty response no error no failures", func(t *testing.T) {
		embed := automationCompletedEmbed(automation.Task{}, "", nil, nil)
		if embed != nil {
			t.Errorf("expected nil embed, got %+v", embed)
		}
	})

	t.Run("plain success includes schedule footer", func(t *testing.T) {
		task := automation.Task{Name: "stale-import-handler", Schedule: "0 * * * *"}

		embed := automationCompletedEmbed(task, "Alles in Ordnung.", nil, nil)
		if embed == nil {
			t.Fatal("expected non-nil embed")
		}
		if embed.Footer == nil || embed.Footer.Text != "Zeitplan: "+task.Schedule {
			t.Errorf("footer = %+v, want text %q", embed.Footer, "Zeitplan: "+task.Schedule)
		}
		if embed.Timestamp == "" {
			t.Error("timestamp is empty")
		}
	})

	t.Run("plain success omits footer for unscheduled task", func(t *testing.T) {
		embed := automationCompletedEmbed(automation.Task{}, "Alles in Ordnung.", nil, nil)
		if embed == nil {
			t.Fatal("expected non-nil embed")
		}
		if embed.Footer != nil {
			t.Errorf("footer = %+v, want nil", embed.Footer)
		}
	})

	t.Run("explicit ok status overrides false-positive heuristic", func(t *testing.T) {
		embed := automationCompletedEmbed(automation.Task{}, "STATUS: ok\n\nKeine Fehler gefunden.", nil, nil)
		if embed == nil {
			t.Fatal("expected non-nil embed")
		}
		if !strings.HasPrefix(embed.Title, "✅") {
			t.Errorf("title = %q, want prefix ✅", embed.Title)
		}
		if !strings.Contains(embed.Title, "Abgeschlossen") {
			t.Errorf("title = %q, want to contain %q", embed.Title, "Abgeschlossen")
		}
		if strings.Contains(embed.Description, "STATUS:") {
			t.Errorf("description = %q, should not contain the STATUS: line", embed.Description)
		}
	})
}

func TestParseExplicitStatus(t *testing.T) {
	tests := []struct {
		name     string
		response string
		wantStat automationRunStatus
		wantRest string
		wantOK   bool
	}{
		{
			name:     "explicit error with details",
			response: "STATUS: fehler\n\nDetails",
			wantStat: automationRunError,
			wantRest: "Details",
			wantOK:   true,
		},
		{
			name:     "case-insensitive ok",
			response: "status: OK\nrest",
			wantStat: automationRunOK,
			wantRest: "rest",
			wantOK:   true,
		},
		{
			name:     "unrecognized value falls back",
			response: "STATUS: bogus\nrest",
			wantStat: automationRunOK,
			wantRest: "STATUS: bogus\nrest",
			wantOK:   false,
		},
		{
			name:     "no token present",
			response: "No token",
			wantStat: automationRunOK,
			wantRest: "No token",
			wantOK:   false,
		},
		{
			name:     "token only with empty rest",
			response: "STATUS: warnung",
			wantStat: automationRunWarning,
			wantRest: "",
			wantOK:   true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotStat, gotRest, gotOK := parseExplicitStatus(tt.response)
			if gotStat != tt.wantStat || gotRest != tt.wantRest || gotOK != tt.wantOK {
				t.Errorf("parseExplicitStatus(%q) = (%v, %q, %v), want (%v, %q, %v)",
					tt.response, gotStat, gotRest, gotOK, tt.wantStat, tt.wantRest, tt.wantOK)
			}
		})
	}
}

func TestIsAutomationStatusMessage(t *testing.T) {
	tests := []struct {
		name    string
		message *discordgo.Message
		want    bool
	}{
		{
			name: "footer without status icon is ignored",
			message: &discordgo.Message{Embeds: []*discordgo.MessageEmbed{
				{Title: "Automation status", Footer: &discordgo.MessageEmbedFooter{Text: "botname"}},
			}},
			want: false,
		},
		{
			name: "title icon error",
			message: &discordgo.Message{Embeds: []*discordgo.MessageEmbed{
				{Title: "❌ Fehler"},
			}},
			want: true,
		},
		{
			name: "title icon warning",
			message: &discordgo.Message{Embeds: []*discordgo.MessageEmbed{
				{Title: "⚠️ Manuelle Prüfung nötig"},
			}},
			want: true,
		},
		{
			name: "title icon empty",
			message: &discordgo.Message{Embeds: []*discordgo.MessageEmbed{
				{Title: "ℹ️ Keine Änderungen"},
			}},
			want: true,
		},
		{
			name: "title icon started",
			message: &discordgo.Message{Embeds: []*discordgo.MessageEmbed{
				{Title: "🚀 Lauf gestartet"},
			}},
			want: true,
		},
		{
			name: "title icon ok",
			message: &discordgo.Message{Embeds: []*discordgo.MessageEmbed{
				{Title: "✅ Abgeschlossen"},
			}},
			want: true,
		},
		{
			name:    "plain text message with no embeds",
			message: &discordgo.Message{Content: "just a regular message"},
			want:    false,
		},
		{
			name: "nil embed entries are skipped",
			message: &discordgo.Message{Embeds: []*discordgo.MessageEmbed{
				nil,
				{Title: "Some unrelated title"},
			}},
			want: false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isAutomationStatusMessage(tt.message); got != tt.want {
				t.Errorf("isAutomationStatusMessage() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestFormatToolFailures(t *testing.T) {
	tests := []struct {
		name     string
		failures []automation.ToolFailure
		want     string
	}{
		{
			name:     "no failures",
			failures: nil,
			want:     "",
		},
		{
			name: "duplicate tool names are deduped",
			failures: []automation.ToolFailure{
				{Tool: "sonarr", Error: "some error"},
				{Tool: "sonarr", Error: "another error"},
			},
			want: "**Tools:** `sonarr`\n**Grund:** Fehler beim Dienstaufruf",
		},
		{
			name: "timeout error changes reason",
			failures: []automation.ToolFailure{
				{Tool: "radarr", Error: "Timeout while calling service"},
			},
			want: "**Tools:** `radarr`\n**Grund:** Timeout beim Dienstaufruf",
		},
		{
			name: "empty tool names fall back to unbekannt",
			failures: []automation.ToolFailure{
				{Tool: "", Error: "some error"},
			},
			want: "**Tools:** unbekannt\n**Grund:** Fehler beim Dienstaufruf",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := formatToolFailures(tt.failures); got != tt.want {
				t.Errorf("formatToolFailures() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestTruncateDiscordDescription(t *testing.T) {
	t.Run("short text is unchanged", func(t *testing.T) {
		value := strings.Repeat("a", 3900)
		if got := truncateDiscordDescription(value); got != value {
			t.Errorf("truncateDiscordDescription() changed a %d-rune string", len([]rune(value)))
		}
	})

	t.Run("long multi-byte text is truncated at rune boundary", func(t *testing.T) {
		value := strings.Repeat("ä", 4000)
		got := truncateDiscordDescription(value)
		want := strings.Repeat("ä", 3900) + "\n\n… gekürzt"
		if got != want {
			t.Errorf("truncateDiscordDescription() length = %d runes, want truncation with suffix", len([]rune(got)))
		}
		if !strings.HasSuffix(got, "\n\n… gekürzt") {
			t.Errorf("truncateDiscordDescription() = %q, want suffix %q", got, "\n\n… gekürzt")
		}
	})
}

func TestDecorateAndTrimHeadings(t *testing.T) {
	t.Run("decorate replaces known heading lines", func(t *testing.T) {
		input := "Importiert:\n- Item A"
		want := "### ✅ Importiert\n- Item A"
		if got := decorateAutomationOutput(input); got != want {
			t.Errorf("decorateAutomationOutput() = %q, want %q", got, want)
		}
	})

	t.Run("single heading is trimmed", func(t *testing.T) {
		input := "### ✅ Importiert\n- Item A\n- Item B"
		want := "- Item A\n- Item B"
		if got := trimLeadingSingleAutomationHeading(input); got != want {
			t.Errorf("trimLeadingSingleAutomationHeading() = %q, want %q", got, want)
		}
	})

	t.Run("two headings are kept", func(t *testing.T) {
		input := "### ✅ Importiert\n- Item A\n### 🗑️ Entfernt\n- Item B"
		if got := trimLeadingSingleAutomationHeading(input); got != input {
			t.Errorf("trimLeadingSingleAutomationHeading() = %q, want unchanged %q", got, input)
		}
	})
}
