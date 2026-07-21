package pi

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"blitzcrank/internal/config"
	"blitzcrank/internal/harness"
)

func TestArgsForAutomationUsesNoSession(t *testing.T) {
	runner := NewRunner(config.Config{
		PiSessionsDir: "/tmp/blitzcrank-pi-sessions",
		PiCWD:         "../..",
	})

	args, err := runner.argsFor(harness.Request{Source: "automation_cron", ThreadID: "automation:hourly-stale-import-handler"})
	if err != nil {
		t.Fatalf("argsFor returned error: %v", err)
	}

	joined := strings.Join(args, " ")
	if !containsArg(args, "--no-session") {
		t.Fatalf("expected --no-session for automation run, got %q", joined)
	}
	if !containsArg(args, "--no-context-files") {
		t.Fatalf("expected repository context files to be disabled, got %q", joined)
	}
	if got := argValue(args, "--system-prompt"); !strings.HasSuffix(got, ".pi/system-prompts/automation.md") {
		t.Fatalf("system prompt = %q, want automation profile", got)
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
	runner := NewRunner(config.Config{PiSessionsDir: "/tmp/blitzcrank-pi-sessions", PiCWD: "../.."})

	args, err := runner.argsFor(harness.Request{Source: "seerr_webhook", ThreadID: "issue:123"})
	if err != nil {
		t.Fatalf("argsFor returned error: %v", err)
	}

	joined := strings.Join(args, " ")
	if !containsArg(args, "--session") {
		t.Fatalf("expected --session for issue run, got %q", joined)
	}
	if got := argValue(args, "--system-prompt"); !strings.HasSuffix(got, ".pi/system-prompts/seerr-issue.md") {
		t.Fatalf("system prompt = %q, want Seerr issue profile", got)
	}
	if !containsArg(args, "--extension") || !containsArgSuffix(args, ".pi/extensions/blitzcrank-tools.ts") {
		t.Fatalf("expected explicit Blitzcrank extension so Pi loads service tools in rpc mode, got %q", joined)
	}
	if !containsTool(args, "report_progress") {
		t.Fatalf("expected report_progress tool for issue run, got %q", joined)
	}
	if containsArg(args, "--no-session") {
		t.Fatalf("did not expect --no-session for issue run, got %q", joined)
	}
}

func TestSourceProfilesIsolateDiscordSessionsAndTools(t *testing.T) {
	runner := NewRunner(config.Config{PiSessionsDir: "/tmp/blitzcrank-pi-sessions", PiCWD: "../.."})
	tests := []struct {
		name           string
		req            harness.Request
		wantSession    bool
		wantNamespace  string
		wantPrompt     string
		wantTools      []string
		forbiddenTools []string
	}{
		{
			name:           "triage has no tools or session",
			req:            harness.Request{Source: "discord_triage", ThreadID: "channel:1"},
			wantPrompt:     "discord-triage.md",
			forbiddenTools: []string{"seerr_request", "web_search", "thread_history_search"},
		},
		{
			name:           "direct has scoped read tools without a session",
			req:            harness.Request{Source: "discord_direct", ThreadID: "channel:1"},
			wantPrompt:     "discord-agent.md",
			wantTools:      []string{"jellyfin_request", "sonarr_request", "radarr_request", "web_search", "web_fetch"},
			forbiddenTools: []string{"seerr_request", "sabnzbd_request", "anvil_status", "thread_history_search"},
		},
		{
			name:           "private thread has isolated durable session",
			req:            harness.Request{Source: "discord_thread", ThreadID: "123456"},
			wantSession:    true,
			wantNamespace:  "discord",
			wantPrompt:     "discord-agent.md",
			wantTools:      []string{"seerr_request", "jellyfin_request", "sonarr_request", "radarr_request"},
			forbiddenTools: []string{"thread_history_search"},
		},
		{
			name:           "review has no tools or session",
			req:            harness.Request{Source: "mutation_review", ThreadID: "run:1"},
			wantPrompt:     "mutation-review.md",
			forbiddenTools: []string{"seerr_request", "web_search", "thread_history_search"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			args, err := runner.argsFor(tt.req)
			if err != nil {
				t.Fatalf("argsFor() error = %v", err)
			}
			if got := containsArg(args, "--session"); got != tt.wantSession {
				t.Fatalf("--session present = %t, want %t: %q", got, tt.wantSession, args)
			}
			if got := filepath.Base(argValue(args, "--system-prompt")); got != tt.wantPrompt {
				t.Fatalf("system prompt = %q, want %q", got, tt.wantPrompt)
			}
			if !containsArg(args, "--no-context-files") {
				t.Fatalf("expected repository context files to be disabled: %q", args)
			}
			for _, tool := range tt.wantTools {
				if !containsTool(args, tool) {
					t.Errorf("expected tool %q in %q", tool, args)
				}
			}
			for _, tool := range tt.forbiddenTools {
				if containsTool(args, tool) {
					t.Errorf("unexpected tool %q in %q", tool, args)
				}
			}
			if tt.wantNamespace != "" {
				path := runner.sessionPath(tt.req)
				if filepath.Base(filepath.Dir(path)) != tt.wantNamespace {
					t.Errorf("session namespace = %q, want %q (path %q)", filepath.Base(filepath.Dir(path)), tt.wantNamespace, path)
				}
			}
		})
	}
}

func TestSeerrAndDiscordSessionDirectoriesArePartitioned(t *testing.T) {
	runner := NewRunner(config.Config{PiSessionsDir: "/tmp/sessions"})
	seerr := runner.sessionPath(harness.Request{Source: "seerr_issue_comment", ThreadID: "issue:42"})
	discord := runner.sessionPath(harness.Request{Source: "discord_thread", ThreadID: "42"})
	if filepath.Dir(seerr) == filepath.Dir(discord) {
		t.Fatalf("session directories overlap: seerr=%q discord=%q", seerr, discord)
	}
	if got := runner.sessionDirectoryFor(harness.Request{Source: "automation_cron"}); filepath.Base(got) != "seerr" {
		t.Fatalf("automation history directory = %q, want seerr namespace", got)
	}
}

func TestPrepareSessionStorageMigratesOnlyLegacyJSONLSessions(t *testing.T) {
	base := t.TempDir()
	legacy := filepath.Join(base, "issue-42.jsonl")
	if err := os.WriteFile(legacy, []byte("legacy session"), 0o600); err != nil {
		t.Fatal(err)
	}
	note := filepath.Join(base, "note.txt")
	if err := os.WriteFile(note, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	runner := NewRunner(config.Config{PiSessionsDir: base})
	if err := runner.PrepareSessionStorage(); err != nil {
		t.Fatalf("PrepareSessionStorage() error = %v", err)
	}
	target := filepath.Join(base, "seerr", "issue-42.jsonl")
	if data, err := os.ReadFile(target); err != nil || string(data) != "legacy session" {
		t.Fatalf("migrated session data=%q error=%v", data, err)
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatalf("legacy session still exists, error=%v", err)
	}
	if _, err := os.Stat(note); err != nil {
		t.Fatalf("non-session file was moved: %v", err)
	}
}

func TestReviewerCapacityIsReservedFromOrdinaryRuns(t *testing.T) {
	runner := NewRunner(config.Config{MaxConcurrentRuns: 1, ReviewCapacity: 1})
	ordinary := harness.Request{Source: "discord_thread"}
	reviewer := harness.Request{Source: "mutation_review"}
	if err := runner.acquire(context.Background(), ordinary); err != nil {
		t.Fatalf("acquire ordinary slot: %v", err)
	}
	defer runner.release(ordinary)

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := runner.acquire(ctx, reviewer); err != nil {
		t.Fatalf("reviewer should use reserved capacity: %v", err)
	}
	runner.release(reviewer)
}

func TestPromptForIssueContainsOnlyTaskAndServiceSkills(t *testing.T) {
	runner := NewRunner(config.Config{PiCWD: "../.."})

	prompt := runner.prompt(harness.Request{
		Source:   "seerr_webhook",
		ThreadID: "issue:123",
		Author:   "user",
		Audience: "seerr_issue",
		Content:  "Issue id: 123",
	})

	for _, want := range []string{
		"/skill:seerr",
		"/skill:jellyfin",
		"/skill:sonarr",
		"/skill:radarr",
		"/skill:sabnzbd",
		"/skill:anvil",
		"/skill:filesystem",
		"Handle this Seerr issue event.",
		"Issue id: 123",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, "seerr-issue-solver") {
		t.Fatalf("prompt should not load the old solver skill:\n%s", prompt)
	}
	if strings.Contains(prompt, "System prompt:") || strings.Contains(prompt, "Blitzcrank Seerr Issue Agent") {
		t.Fatalf("actual system prompt leaked into the RPC user message:\n%s", prompt)
	}
}

func TestPromptForAutomationContainsOnlyTaskAndServiceSkills(t *testing.T) {
	runner := NewRunner(config.Config{PiCWD: "../.."})

	prompt := runner.prompt(harness.Request{
		Source:   "automation_cron",
		ThreadID: "automation:hourly-stale-import-handler",
		Audience: "automation",
		Content:  "Automation body",
	})

	for _, want := range []string{
		"/skill:sonarr",
		"/skill:radarr",
		"/skill:sabnzbd",
		"/skill:anvil",
		"/skill:filesystem",
		"Run this scheduled Blitzcrank media-server automation.",
		"Automation body",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, "/skill:seerr") || strings.Contains(prompt, "seerr-issue-solver") {
		t.Fatalf("automation prompt loaded issue-only skill content:\n%s", prompt)
	}
	if strings.Contains(prompt, "System prompt:") || strings.Contains(prompt, "Blitzcrank Automation Agent") {
		t.Fatalf("actual system prompt leaked into the RPC user message:\n%s", prompt)
	}
}

func TestDiscordTasksDoNotEmbedDedicatedSystemProfiles(t *testing.T) {
	runner := NewRunner(config.Config{PiCWD: "../.."})
	tests := []struct {
		name   string
		req    harness.Request
		marker string
	}{
		{
			name:   "triage",
			req:    harness.Request{Source: "discord_triage", ThreadID: "channel:1", ActorID: "user:1", Content: "Wann kommt die Folge?"},
			marker: "# Blitzcrank Discord Triage",
		},
		{
			name:   "agent",
			req:    harness.Request{Source: "discord_thread", ThreadID: "thread:1", ActorID: "user:1", Authority: "Bitte reparieren"},
			marker: "# Blitzcrank Discord Agent",
		},
		{
			name:   "review",
			req:    harness.Request{Source: "mutation_review", Content: `{"service":"sonarr"}`},
			marker: "# Blitzcrank Mutation Reviewer",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			prompt := runner.prompt(tt.req)
			if strings.Contains(prompt, tt.marker) {
				t.Fatalf("system profile %q leaked into task prompt:\n%s", tt.marker, prompt)
			}
		})
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

func TestReadUntilAgentEndReportsToolFailure(t *testing.T) {
	stream := `{"type":"response","id":"blitzcrank-request","success":true}
{"type":"tool_execution_end","toolName":"sonarr_request","isError":true,"error":"boom"}
{"type":"agent_end","messages":[{"role":"assistant","content":"final answer"}]}
`
	var events []harness.ProgressEvent
	req := harness.Request{Progress: func(ev harness.ProgressEvent) {
		events = append(events, ev)
	}}

	final, err := readUntilAgentEnd(context.Background(), strings.NewReader(stream), req)
	if err != nil {
		t.Fatalf("readUntilAgentEnd returned error: %v", err)
	}
	if final != "final answer" {
		t.Fatalf("expected %q, got %q", "final answer", final)
	}

	var found bool
	for _, ev := range events {
		if ev.Phase != "tool_done" {
			continue
		}
		found = true
		if ev.Error != "boom" {
			t.Fatalf("expected Error %q, got %q", "boom", ev.Error)
		}
	}
	if !found {
		t.Fatalf("expected a tool_done progress event, got %+v", events)
	}
}

func TestReadUntilAgentEndForwardsGeneratedProgressMessage(t *testing.T) {
	stream := `{"type":"response","id":"blitzcrank-request","success":true}
{"type":"tool_execution_start","toolName":"report_progress","args":{"message":"Ich prüfe die gemeldete Episode."}}
{"type":"tool_execution_end","toolName":"report_progress"}
{"type":"agent_end","messages":[{"role":"assistant","content":"final answer"}]}
`
	var events []harness.ProgressEvent
	req := harness.Request{Progress: func(event harness.ProgressEvent) {
		events = append(events, event)
	}}

	if _, err := readUntilAgentEnd(context.Background(), strings.NewReader(stream), req); err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].Phase != "status" || events[0].Message != "Ich prüfe die gemeldete Episode." {
		t.Fatalf("progress events = %+v", events)
	}
}

func TestReadUntilAgentEndToolDoneWithoutErrorFieldsHasNoError(t *testing.T) {
	stream := `{"type":"response","id":"blitzcrank-request","success":true}
{"type":"tool_execution_end","toolName":"sonarr_request"}
{"type":"agent_end","messages":[{"role":"assistant","content":"final answer"}]}
`
	var events []harness.ProgressEvent
	req := harness.Request{Progress: func(ev harness.ProgressEvent) {
		events = append(events, ev)
	}}

	final, err := readUntilAgentEnd(context.Background(), strings.NewReader(stream), req)
	if err != nil {
		t.Fatalf("readUntilAgentEnd returned error: %v", err)
	}
	if final != "final answer" {
		t.Fatalf("expected %q, got %q", "final answer", final)
	}

	var found bool
	for _, ev := range events {
		if ev.Phase != "tool_done" {
			continue
		}
		found = true
		if ev.Error != "" {
			t.Fatalf("expected empty Error, got %q", ev.Error)
		}
	}
	if !found {
		t.Fatalf("expected a tool_done progress event, got %+v", events)
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

func argValue(args []string, name string) string {
	for index, arg := range args {
		if arg == name && index+1 < len(args) {
			return args[index+1]
		}
	}
	return ""
}
