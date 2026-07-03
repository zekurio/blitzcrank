package pi

import (
	"context"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

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

func TestReadUntilAgentEndReturnsFinalAssistantText(t *testing.T) {
	stream := `{"type":"response","id":"blitzcrank-request","success":true}
{"type":"agent_end","messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"final answer"}]}
`
	final, err := readUntilAgentEnd(context.Background(), strings.NewReader(stream), harness.Request{})
	if err != nil {
		t.Fatalf("readUntilAgentEnd returned error: %v", err)
	}
	if final != "final answer" {
		t.Fatalf("expected %q, got %q", "final answer", final)
	}
}

func TestReadUntilAgentEndIgnoresTrailingOutputAfterAgentEnd(t *testing.T) {
	// A stream with extra JSON lines after agent_end leaves the scanner
	// goroutine parked on `lines <- event` (nobody is reading anymore).
	// It should only unblock once the context passed to readUntilAgentEnd
	// is canceled -- proving the reader is tied to the per-run context.
	stream := `{"type":"response","id":"blitzcrank-request","success":true}
{"type":"agent_end","messages":[{"role":"assistant","content":"final answer"}]}
{"type":"tool_execution_start","toolName":"noop"}
{"type":"tool_execution_end","toolName":"noop"}
`
	ctx, cancel := context.WithCancel(context.Background())

	final, err := readUntilAgentEnd(ctx, strings.NewReader(stream), harness.Request{})
	if err != nil {
		t.Fatalf("readUntilAgentEnd returned error: %v", err)
	}
	if final != "final answer" {
		t.Fatalf("expected %q, got %q", "final answer", final)
	}

	// The scanner goroutine's name never changes; look for it by stack frame
	// instead of a raw NumGoroutine count so unrelated GC/runtime goroutines
	// can't make this flaky.
	const marker = "blitzcrank/internal/pi.readUntilAgentEnd.func1"

	if !waitForGoroutine(marker, true, 5*time.Second) {
		t.Fatalf("expected scanner goroutine %q to still be parked before cancel", marker)
	}

	cancel()

	if !waitForGoroutine(marker, false, 5*time.Second) {
		t.Fatalf("scanner goroutine %q leaked after context cancel", marker)
	}
}

// waitForGoroutine polls the process's goroutine stack dump until a frame
// containing marker is present (want=true) or absent (want=false), or the
// timeout elapses. It returns whether the desired state was observed.
func waitForGoroutine(marker string, want bool, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	buf := make([]byte, 1<<20)
	for {
		n := runtime.Stack(buf, true)
		present := strings.Contains(string(buf[:n]), marker)
		if present == want {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestReadUntilAgentEndPromptRejected(t *testing.T) {
	stream := `{"type":"response","id":"blitzcrank-request","success":false,"error":"bad prompt"}
`
	_, err := readUntilAgentEnd(context.Background(), strings.NewReader(stream), harness.Request{})
	if err == nil {
		t.Fatalf("expected error for rejected prompt")
	}
	if !strings.Contains(err.Error(), "bad prompt") {
		t.Fatalf("expected error to contain %q, got %v", "bad prompt", err)
	}
}

func TestSafeBufferConcurrentWriteAndString(t *testing.T) {
	var buf safeBuffer

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 1000; i++ {
			_, _ = buf.Write([]byte("x"))
		}
	}()

	for i := 0; i < 1000; i++ {
		_ = buf.String()
	}
	wg.Wait()
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
