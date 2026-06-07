package pi

import (
	"strings"
	"testing"

	"blitzcrank/internal/config"
	"blitzcrank/internal/harness"
)

func TestArgsForAutomationUsesNoSession(t *testing.T) {
	runner := NewRunner(config.Config{PiSessionsDir: "/tmp/blitzcrank-pi-sessions"})

	args, err := runner.argsFor(harness.Request{Source: "automation_cron", ThreadID: "automation:hourly-stale-import-handler"})
	if err != nil {
		t.Fatalf("argsFor returned error: %v", err)
	}

	joined := strings.Join(args, " ")
	if !containsArg(args, "--no-session") {
		t.Fatalf("expected --no-session for automation run, got %q", joined)
	}
	if containsArg(args, "--session") {
		t.Fatalf("did not expect --session for automation run, got %q", joined)
	}
}

func TestArgsForIssueUsesSession(t *testing.T) {
	runner := NewRunner(config.Config{PiSessionsDir: "/tmp/blitzcrank-pi-sessions"})

	args, err := runner.argsFor(harness.Request{Source: "seerr_webhook", ThreadID: "issue:123"})
	if err != nil {
		t.Fatalf("argsFor returned error: %v", err)
	}

	joined := strings.Join(args, " ")
	if !containsArg(args, "--session") {
		t.Fatalf("expected --session for issue run, got %q", joined)
	}
	if containsArg(args, "--no-session") {
		t.Fatalf("did not expect --no-session for issue run, got %q", joined)
	}
}

func TestPromptForIssueUsesSystemPromptAndServiceSkills(t *testing.T) {
	runner := NewRunner(config.Config{PiCWD: "../.."})

	prompt, err := runner.prompt(harness.Request{
		Source:   "seerr_webhook",
		ThreadID: "issue:123",
		Author:   "user",
		Audience: "seerr_issue",
		Content:  "Issue id: 123",
	})
	if err != nil {
		t.Fatalf("prompt returned error: %v", err)
	}

	for _, want := range []string{
		"/skill:seerr",
		"/skill:jellyfin",
		"/skill:sonarr",
		"/skill:radarr",
		"/skill:sabnzbd",
		"/skill:filesystem",
		"System prompt:\n\n# Blitzcrank Seerr Issue Agent",
		"Task prompt:\n\nHandle this Seerr issue event.",
		"Issue id: 123",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, "seerr-issue-solver") {
		t.Fatalf("prompt should not load the old solver skill:\n%s", prompt)
	}
}

func TestPromptForAutomationUsesAutomationSystemPromptAndServiceSkills(t *testing.T) {
	runner := NewRunner(config.Config{PiCWD: "../.."})

	prompt, err := runner.prompt(harness.Request{
		Source:   "automation_cron",
		ThreadID: "automation:hourly-stale-import-handler",
		Audience: "automation",
		Content:  "Automation body",
	})
	if err != nil {
		t.Fatalf("prompt returned error: %v", err)
	}

	for _, want := range []string{
		"/skill:sonarr",
		"/skill:radarr",
		"/skill:sabnzbd",
		"/skill:filesystem",
		"System prompt:\n\n# Blitzcrank Automation Agent",
		"Task prompt:\n\nRun this scheduled Blitzcrank media-server automation.",
		"Automation body",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, "/skill:seerr") || strings.Contains(prompt, "seerr-issue-solver") {
		t.Fatalf("automation prompt loaded issue-only skill content:\n%s", prompt)
	}
}

func containsArg(args []string, want string) bool {
	for _, arg := range args {
		if arg == want {
			return true
		}
	}
	return false
}
