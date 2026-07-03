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
		embed := automationCompletedEmbed("", errors.New("boom"), nil, "botname")
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
		embed := automationCompletedEmbed("Alles gut gelaufen.", nil, failures, "botname")
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
		embed := automationCompletedEmbed("", nil, nil, "botname")
		if embed != nil {
			t.Errorf("expected nil embed, got %+v", embed)
		}
	})

	t.Run("plain success", func(t *testing.T) {
		embed := automationCompletedEmbed("Alles in Ordnung.", nil, nil, "botname")
		if embed == nil {
			t.Fatal("expected non-nil embed")
		}
		if embed.Footer == nil || embed.Footer.Text != "botname" {
			t.Errorf("footer = %+v, want text %q", embed.Footer, "botname")
		}
	})
}

func TestIsAutomationStatusMessage(t *testing.T) {
	tests := []struct {
		name    string
		message *discordgo.Message
		botName string
		want    bool
	}{
		{
			name: "footer matches bot name",
			message: &discordgo.Message{Embeds: []*discordgo.MessageEmbed{
				{Footer: &discordgo.MessageEmbedFooter{Text: "botname"}},
			}},
			botName: "botname",
			want:    true,
		},
		{
			name: "title icon error",
			message: &discordgo.Message{Embeds: []*discordgo.MessageEmbed{
				{Title: "❌ Fehler"},
			}},
			botName: "botname",
			want:    true,
		},
		{
			name: "title icon warning",
			message: &discordgo.Message{Embeds: []*discordgo.MessageEmbed{
				{Title: "⚠️ Manuelle Prüfung nötig"},
			}},
			botName: "botname",
			want:    true,
		},
		{
			name: "title icon empty",
			message: &discordgo.Message{Embeds: []*discordgo.MessageEmbed{
				{Title: "ℹ️ Keine Änderungen"},
			}},
			botName: "botname",
			want:    true,
		},
		{
			name: "title icon started",
			message: &discordgo.Message{Embeds: []*discordgo.MessageEmbed{
				{Title: "🚀 Lauf gestartet"},
			}},
			botName: "botname",
			want:    true,
		},
		{
			name: "title icon ok",
			message: &discordgo.Message{Embeds: []*discordgo.MessageEmbed{
				{Title: "✅ Abgeschlossen"},
			}},
			botName: "botname",
			want:    true,
		},
		{
			name:    "plain text message with no embeds",
			message: &discordgo.Message{Content: "just a regular message"},
			botName: "botname",
			want:    false,
		},
		{
			name: "nil embed entries are skipped",
			message: &discordgo.Message{Embeds: []*discordgo.MessageEmbed{
				nil,
				{Title: "Some unrelated title"},
			}},
			botName: "botname",
			want:    false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isAutomationStatusMessage(tt.message, tt.botName); got != tt.want {
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
