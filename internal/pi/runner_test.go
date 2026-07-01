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
	if !containsArg(args, "--extension") || !containsArgSuffix(args, ".pi/extensions/blitzcrank-tools.ts") {
		t.Fatalf("expected explicit Blitzcrank extension so Pi loads service tools in rpc mode, got %q", joined)
	}
	if !containsTool(args, "anvil_status") {
		t.Fatalf("expected anvil_status tool for automation run, got %q", joined)
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
	if !containsArg(args, "--extension") || !containsArgSuffix(args, ".pi/extensions/blitzcrank-tools.ts") {
		t.Fatalf("expected explicit Blitzcrank extension so Pi loads service tools in rpc mode, got %q", joined)
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
		"/skill:anvil",
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
		"/skill:anvil",
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

func TestEnvPassesConfiguredAnvilSystemdUnit(t *testing.T) {
	runner := NewRunner(config.Config{AnvilSystemdUnit: "anvil-transcode.service"})

	env := runner.env(harness.Request{})

	if !containsArg(env, "ANVIL_SYSTEMD_UNIT=anvil-transcode.service") {
		t.Fatalf("env missing configured Anvil unit")
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

func containsTool(args []string, want string) bool {
	for index, arg := range args {
		if arg != "--tools" || index+1 >= len(args) {
			continue
		}
		for _, tool := range strings.Split(args[index+1], ",") {
			if strings.TrimSpace(tool) == want {
				return true
			}
		}
	}
	return false
}

func containsArgSuffix(args []string, want string) bool {
	for _, arg := range args {
		if strings.HasSuffix(arg, want) {
			return true
		}
	}
	return false
}
