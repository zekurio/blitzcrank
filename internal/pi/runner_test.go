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

func containsArg(args []string, want string) bool {
	for _, arg := range args {
		if arg == want {
			return true
		}
	}
	return false
}
