package harness

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"blitzcrank/internal/config"
	"blitzcrank/internal/runtimectx"
	"blitzcrank/internal/tools"
)

type fakeRunner struct {
	calls int
	reply string
	err   error
	model string
}

func (f *fakeRunner) Respond(_ context.Context, req Request) (string, error) {
	f.calls++
	return f.reply, f.err
}

func (f *fakeRunner) ModelName(Request) string {
	return f.model
}

type runtimeRunner struct {
	fakeRunner
	effort string
}

func (r *runtimeRunner) RuntimeInfo(Request) (string, string) {
	return r.model, r.effort
}

type observedRunner struct {
	mu        sync.Mutex
	active    int
	maxActive int
	calls     int
	delay     time.Duration
	reply     string
}

type retryRunner struct {
	calls int
}

type progressRunner struct {
	calls int
}

func (r *retryRunner) Respond(_ context.Context, req Request) (string, error) {
	r.calls++
	if r.calls == 1 {
		return "", errors.New("temporary agent failure")
	}
	return "Erledigt.", nil
}

func (r *progressRunner) Respond(_ context.Context, req Request) (string, error) {
	r.calls++
	if req.Progress != nil {
		req.Progress(ProgressEvent{Phase: "assistant_turn", CurrentResponse: "Ich prüfe die Ursache.", Todos: []TodoItem{{Content: "Ursache prüfen"}, {Content: "Ergebnis melden"}}})
	}
	return "RESOLVE_ISSUE: no\n\nIch konnte den Status prüfen; ein sicherer Fix ist mit den verfügbaren Informationen nicht möglich.", nil
}

func (r *observedRunner) Respond(ctx context.Context, req Request) (string, error) {
	r.mu.Lock()
	r.calls++
	r.active++
	if r.active > r.maxActive {
		r.maxActive = r.active
	}
	r.mu.Unlock()

	select {
	case <-ctx.Done():
	case <-time.After(r.delay):
	}

	r.mu.Lock()
	r.active--
	r.mu.Unlock()
	return r.reply, nil
}

func TestHandleWebhookReportedPostsOneFinalComment(t *testing.T) {
	var posted []string
	var botUser string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/issue/42/comment" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		botUser = r.Header.Get("X-Api-User")
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		posted = append(posted, body["message"])
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	cfg := testConfig(server.URL, t.TempDir())
	cfg.SeerrBotUserID = "7"
	runner := &fakeRunner{reply: "Danke für den Hinweis — die Folge hing in der Sonarr-Warteschlange. Ich habe den Download neu angestoßen und danach geprüft, dass die Warteschlange wieder frei ist."}
	manager := NewManager(cfg, runner, tools.NewRegistry(cfg), nil)

	result, err := manager.HandleWebhook(context.Background(), issuePayload("Problem gemeldet", "alice", "file is stuck"))
	if err != nil {
		t.Fatalf("HandleWebhook() error = %v", err)
	}
	if result.Ignored {
		t.Fatalf("HandleWebhook() ignored = true: %s", result.Reason)
	}
	if runner.calls != 1 {
		t.Fatalf("runner calls = %d, want 1", runner.calls)
	}
	if len(posted) != 1 {
		t.Fatalf("posted comments = %d, want 1", len(posted))
	}
	if botUser != "7" {
		t.Fatalf("X-Api-User = %q, want 7", botUser)
	}
	if !strings.HasPrefix(posted[0], "[blitzcrank w/ gpt-5.5]") {
		t.Fatalf("comment missing signature: %q", posted[0])
	}
}

func TestHandleWebhookResolveDirectivePostsCommentAndResolvesIssue(t *testing.T) {
	var posted []string
	var resolved bool
	var resolvedBotUser string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/issue/42/comment":
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			posted = append(posted, body["message"])
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/issue/42/resolved":
			resolved = true
			resolvedBotUser = r.Header.Get("X-Api-User")
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	cfg := testConfig(server.URL, t.TempDir())
	cfg.SeerrBotUserID = "7"
	runner := &fakeRunner{reply: "RESOLVE_ISSUE: yes\n\nDas Problem wurde behoben und erfolgreich geprüft."}
	manager := NewManager(cfg, runner, tools.NewRegistry(cfg), nil)

	result, err := manager.HandleWebhook(context.Background(), issuePayload("Problem gemeldet", "alice", "file is fixed"))
	if err != nil {
		t.Fatalf("HandleWebhook() error = %v", err)
	}
	if result.Ignored {
		t.Fatalf("HandleWebhook() ignored = true: %s", result.Reason)
	}
	if len(posted) != 1 {
		t.Fatalf("posted comments = %d, want 1", len(posted))
	}
	if strings.Contains(posted[0], "RESOLVE_ISSUE") {
		t.Fatalf("posted comment leaked resolve directive: %q", posted[0])
	}
	if !resolved {
		t.Fatal("issue was not resolved")
	}
	if resolvedBotUser != "7" {
		t.Fatalf("resolve X-Api-User = %q, want 7", resolvedBotUser)
	}
}

func TestHandleWebhookPostsSingleProgressComment(t *testing.T) {
	var posted []string
	var updated []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/issue/42/comment":
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			posted = append(posted, body["message"])
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"comment-1"}`))
		case r.Method == http.MethodPut && r.URL.Path == "/api/v1/issue/42/comment/comment-1":
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			updated = append(updated, body["message"])
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"comment-1"}`))
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	cfg := testConfig(server.URL, t.TempDir())
	runner := &progressRunner{}
	manager := NewManager(cfg, runner, tools.NewRegistry(cfg), nil)

	result, err := manager.HandleWebhook(context.Background(), issuePayload("Problem gemeldet", "alice", "file is stuck"))
	if err != nil {
		t.Fatalf("HandleWebhook() error = %v", err)
	}
	if result.Ignored {
		t.Fatalf("HandleWebhook() ignored = true: %s", result.Reason)
	}
	if runner.calls != 1 {
		t.Fatalf("runner calls = %d, want 1", runner.calls)
	}
	if len(posted) != 1 || len(updated) != 1 {
		t.Fatalf("posted=%d updated=%d, want one post and one update: posted=%#v updated=%#v", len(posted), len(updated), posted, updated)
	}
	if !strings.Contains(posted[0], "[ ] Ursache prüfen") || !strings.Contains(posted[0], "Ich prüfe die Ursache") {
		t.Fatalf("first comment is not progress: %q", posted[0])
	}
	if strings.Contains(updated[0], "RESOLVE_ISSUE") || !strings.Contains(updated[0], "sicherer Fix") {
		t.Fatalf("updated comment is not final: %q", updated[0])
	}
}

func TestHandleWebhookIgnoresBotAuthoredComment(t *testing.T) {
	cfg := testConfig("http://127.0.0.1.invalid", t.TempDir())
	runner := &fakeRunner{reply: "should not run"}
	manager := NewManager(cfg, runner, tools.NewRegistry(cfg), nil)

	payload := issuePayload("Problem Kommentar", "Blitzcrank", "[blitzcrank w/ gpt-5.5]\n\nErledigt")
	result, err := manager.HandleWebhook(context.Background(), payload)
	if err != nil {
		t.Fatalf("HandleWebhook() error = %v", err)
	}
	if !result.Ignored {
		t.Fatal("HandleWebhook() ignored = false, want true")
	}
	if runner.calls != 0 {
		t.Fatalf("runner calls = %d, want 0", runner.calls)
	}
}

func TestHandleWebhookIgnoresDuplicatePayload(t *testing.T) {
	var posted []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posted = append(posted, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	cfg := testConfig(server.URL, t.TempDir())
	runner := &fakeRunner{reply: "Erledigt."}
	manager := NewManager(cfg, runner, tools.NewRegistry(cfg), nil)
	payload := issuePayload("Problem gemeldet", "alice", "file is stuck")

	first, err := manager.HandleWebhook(context.Background(), payload)
	if err != nil {
		t.Fatalf("first HandleWebhook() error = %v", err)
	}
	second, err := manager.HandleWebhook(context.Background(), payload)
	if err != nil {
		t.Fatalf("second HandleWebhook() error = %v", err)
	}
	if first.Ignored {
		t.Fatalf("first result ignored: %s", first.Reason)
	}
	if !second.Ignored || second.Reason != "duplicate webhook event" {
		t.Fatalf("second result = %#v, want duplicate ignored", second)
	}
	if runner.calls != 1 || len(posted) != 1 {
		t.Fatalf("runner calls=%d posted=%d, want one each", runner.calls, len(posted))
	}
}

func TestHandleWebhookRetriesIdenticalPayloadAfterRunFailure(t *testing.T) {
	var posted []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		posted = append(posted, body["message"])
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	cfg := testConfig(server.URL, t.TempDir())
	runner := &retryRunner{}
	manager := NewManager(cfg, runner, tools.NewRegistry(cfg), nil)
	payload := issuePayload("Problem gemeldet", "alice", "file is stuck")

	first, err := manager.HandleWebhook(context.Background(), payload)
	if err == nil {
		t.Fatal("first HandleWebhook() error = nil, want transient failure")
	}
	if first.Ignored {
		t.Fatalf("first result ignored: %s", first.Reason)
	}
	second, err := manager.HandleWebhook(context.Background(), payload)
	if err != nil {
		t.Fatalf("second HandleWebhook() error = %v", err)
	}
	if second.Ignored {
		t.Fatalf("second result ignored: %s", second.Reason)
	}
	if runner.calls != 2 || len(posted) != 1 {
		t.Fatalf("runner calls=%d posted=%d, want retry and one post", runner.calls, len(posted))
	}
}

func TestHandleWebhookUpdatesIssueSummary(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	cfg := testConfig(server.URL, t.TempDir())
	runner := &fakeRunner{reply: "Erledigt."}
	manager := NewManager(cfg, runner, tools.NewRegistry(cfg), nil)

	if _, err := manager.HandleWebhook(context.Background(), issuePayload("Problem gemeldet", "alice", "file is stuck")); err != nil {
		t.Fatalf("HandleWebhook() error = %v", err)
	}
	thread := manager.threads["42"]
	if thread == nil || !strings.Contains(thread.Summary, "Latest solver outcome") || !strings.Contains(thread.Summary, "Erledigt.") {
		t.Fatalf("thread summary = %q", thread.Summary)
	}
}

func TestCommentHeaderIgnoresDeprecatedFastMode(t *testing.T) {
	cfg := testConfig("http://127.0.0.1.invalid", t.TempDir())
	manager := NewManager(cfg, &fakeRunner{}, tools.NewRegistry(cfg), nil)

	if got := manager.commentHeader(); got != "[blitzcrank w/ gpt-5.5]" {
		t.Fatalf("commentHeader() = %q", got)
	}
}

func TestCommentHeaderShortensProviderModelSlug(t *testing.T) {
	cfg := testConfig("http://127.0.0.1.invalid", t.TempDir())
	cfg.PiModels["default"] = "openai-codex/gpt-5.5:medium"
	manager := NewManager(cfg, &fakeRunner{}, tools.NewRegistry(cfg), nil)

	if got := manager.commentHeader(); got != "[blitzcrank w/ gpt-5.5:medium]" {
		t.Fatalf("commentHeader() = %q", got)
	}
}

func TestHandleWebhookHeaderUsesResolvedRunnerModel(t *testing.T) {
	var posted []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		posted = append(posted, body["message"])
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	cfg := testConfig(server.URL, t.TempDir())
	runner := &fakeRunner{reply: "Erledigt.", model: "gpt-skill"}
	manager := NewManager(cfg, runner, tools.NewRegistry(cfg), nil)

	if _, err := manager.HandleWebhook(context.Background(), issuePayload("Problem gemeldet", "alice", "file is stuck")); err != nil {
		t.Fatalf("HandleWebhook() error = %v", err)
	}
	if len(posted) != 1 || !strings.HasPrefix(posted[0], "[blitzcrank w/ gpt-skill]") {
		t.Fatalf("posted comment = %#v, want runner model header", posted)
	}
}

func TestHandleWebhookHeaderUsesResolvedRuntimeInfo(t *testing.T) {
	var posted []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		posted = append(posted, body["message"])
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	cfg := testConfig(server.URL, t.TempDir())
	runner := &runtimeRunner{fakeRunner: fakeRunner{reply: "Erledigt.", model: "gpt-5.5"}, effort: "low"}
	manager := NewManager(cfg, runner, tools.NewRegistry(cfg), nil)

	if _, err := manager.HandleWebhook(context.Background(), issuePayload("Problem gemeldet", "alice", "file is stuck")); err != nil {
		t.Fatalf("HandleWebhook() error = %v", err)
	}
	if len(posted) != 1 || !strings.HasPrefix(posted[0], "[blitzcrank w/ gpt-5.5 low]") {
		t.Fatalf("posted comment = %#v, want model and reasoning header", posted)
	}
}

func TestHandleWebhookSerializesRunsForSameIssue(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	cfg := testConfig(server.URL, t.TempDir())
	runner := &observedRunner{reply: "Erledigt.", delay: 40 * time.Millisecond}
	manager := NewManager(cfg, runner, tools.NewRegistry(cfg), nil)

	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			if _, err := manager.HandleWebhook(context.Background(), issuePayload("Problem gemeldet", "alice", "file is stuck "+string(rune('A'+index)))); err != nil {
				t.Errorf("HandleWebhook() error = %v", err)
			}
		}(i)
	}
	wg.Wait()

	runner.mu.Lock()
	defer runner.mu.Unlock()
	if runner.calls != 2 {
		t.Fatalf("runner calls = %d, want 2", runner.calls)
	}
	if runner.maxActive != 1 {
		t.Fatalf("max concurrent runs = %d, want 1", runner.maxActive)
	}
}

func TestHandleWebhookDoesNotPostEmptyFinalComment(t *testing.T) {
	var posted []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posted = append(posted, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	cfg := testConfig(server.URL, t.TempDir())
	runner := &fakeRunner{reply: "   "}
	manager := NewManager(cfg, runner, tools.NewRegistry(cfg), nil)

	if _, err := manager.HandleWebhook(context.Background(), issuePayload("Problem gemeldet", "alice", "file is stuck")); err == nil {
		t.Fatal("HandleWebhook() error = nil, want empty comment error")
	}
	if len(posted) != 0 {
		t.Fatalf("posted comments = %#v, want none", posted)
	}
}

func TestHandleWebhookRejectsUnsafeFinalComment(t *testing.T) {
	var posted []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posted = append(posted, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	cfg := testConfig(server.URL, t.TempDir())
	runner := &fakeRunner{reply: "Validierung: bitte prüfen, ob es jetzt geht."}
	manager := NewManager(cfg, runner, tools.NewRegistry(cfg), nil)

	if _, err := manager.HandleWebhook(context.Background(), issuePayload("Problem gemeldet", "alice", "file is stuck")); err == nil {
		t.Fatal("HandleWebhook() error = nil, want validation error")
	}
	if len(posted) != 0 {
		t.Fatalf("posted comments = %#v, want none", posted)
	}
}

func TestHandleWebhookRejectsSignedFinalCommentOverLimit(t *testing.T) {
	var posted []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posted = append(posted, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	cfg := testConfig(server.URL, t.TempDir())
	runner := &fakeRunner{reply: strings.Repeat("a", 1590)}
	manager := NewManager(cfg, runner, tools.NewRegistry(cfg), nil)

	if _, err := manager.HandleWebhook(context.Background(), issuePayload("Problem gemeldet", "alice", "file is stuck")); err == nil {
		t.Fatal("HandleWebhook() error = nil, want signed comment length error")
	}
	if len(posted) != 0 {
		t.Fatalf("posted comments = %#v, want none", posted)
	}
}

func TestHandleWebhookResolvedWritesIssueJSONLTraceOnly(t *testing.T) {
	dir := t.TempDir()
	cfg := testConfig("http://127.0.0.1.invalid", dir)
	manager := NewManager(cfg, &fakeRunner{}, tools.NewRegistry(cfg), nil)

	result, err := manager.HandleWebhook(context.Background(), issuePayload("Problem gelöst", "alice", "fixed"))
	if err != nil {
		t.Fatalf("HandleWebhook() error = %v", err)
	}
	if result.Ignored {
		t.Fatalf("HandleWebhook() ignored = true: %s", result.Reason)
	}

	legacyJSONPath := filepath.Join(dir, "issue-42.json")
	if _, err := os.Stat(legacyJSONPath); !os.IsNotExist(err) {
		t.Fatalf("unexpected legacy issue JSON at %s: %v", legacyJSONPath, err)
	}

	tracePath := filepath.Join(dir, "issues", "issue-42.jsonl")
	data, err := os.ReadFile(tracePath)
	if err != nil {
		t.Fatalf("ReadFile(%s) error = %v", tracePath, err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 2 {
		t.Fatalf("trace lines = %d, want 2: %s", len(lines), data)
	}
	var completion map[string]any
	if err := json.Unmarshal([]byte(lines[1]), &completion); err != nil {
		t.Fatalf("Unmarshal completion trace error = %v", err)
	}
	if completion["type"] != "issue_completed" {
		t.Fatalf("completion trace type = %v, want issue_completed", completion["type"])
	}
}

func TestIssueToolCallWritesJSONLTrace(t *testing.T) {
	dir := t.TempDir()
	cfg := testConfig("http://127.0.0.1.invalid", dir)
	manager := NewManager(cfg, &fakeRunner{}, tools.NewRegistry(cfg), nil)
	startedAt := time.Date(2026, 5, 16, 10, 0, 0, 0, time.UTC)
	manager.recordToolCall("42", "reported", startedAt, ToolAuditRecord{
		Name:             "seerr_get_issue",
		ArgumentsSummary: `{"issue_id":"42"}`,
		ResultSummary:    `{"id":42}`,
		StartedAt:        startedAt,
		CompletedAt:      startedAt.Add(time.Second),
	})

	data, err := os.ReadFile(filepath.Join(dir, "issues", "issue-42.jsonl"))
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	var record map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(data))), &record); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if record["type"] != "tool_call" || record["tool_name"] != "seerr_get_issue" {
		t.Fatalf("tool call trace = %#v", record)
	}
}

func TestIssuePromptContextReportsCompactions(t *testing.T) {
	base := time.Date(2026, 5, 16, 10, 0, 0, 0, time.UTC)
	thread := &IssueThread{IssueID: "42", Summary: "older context summarized"}
	for i := 0; i < issueRecentEventLimit+1; i++ {
		message := "event message"
		if i == issueRecentEventLimit {
			message = strings.Repeat("e", issueLineValueLimit+1)
		}
		thread.Events = append(thread.Events, ThreadEvent{
			Type:    "comment",
			Key:     fmt.Sprintf("event-%02d", i),
			Actor:   "alice",
			Message: message,
			At:      base.Add(time.Duration(i) * time.Minute),
		})
	}
	for i := 0; i < issueRecentRunLimit+1; i++ {
		comment := "run result"
		if i == issueRecentRunLimit {
			comment = strings.Repeat("r", issueLineValueLimit+1)
		}
		thread.Runs = append(thread.Runs, RunRecord{
			StartedAt:        base.Add(time.Duration(i) * time.Hour),
			FinalComment:     comment,
			CompletionReason: "completed",
		})
	}

	manager := &Manager{}
	result := manager.issuePromptContext(thread, map[string]any{
		"message": strings.Repeat("payload", issuePromptPayloadLimit/2),
	}, "comment")

	if result.Content == "" {
		t.Fatal("prompt content is empty")
	}
	components := map[string]bool{}
	for _, entry := range result.Compactions {
		component, _ := entry.Details["component"].(string)
		components[component] = true
		if entry.Summary == "" || entry.FirstKeptEntryID == "" || entry.TokensBefore <= 0 {
			t.Fatalf("invalid compaction entry: %#v", entry)
		}
	}
	for _, component := range []string{"seerr_recent_events", "seerr_recent_runs", "seerr_event_line_values", "seerr_run_line_values", "seerr_webhook_payload"} {
		if !components[component] {
			t.Fatalf("missing compaction component %q in %#v", component, components)
		}
	}
}

func TestRecordIssuePromptCompactionsWritesLedgerAndTrace(t *testing.T) {
	dir := t.TempDir()
	cfg := testConfig("http://127.0.0.1.invalid", dir)
	manager := NewManager(cfg, &fakeRunner{}, tools.NewRegistry(cfg), nil)
	entries := []runtimectx.CompactionEntry{
		runtimectx.NewCompactionEntry(runtimectx.NewCompactionEntryOptions{
			Summary:          "Seerr issue event context compacted.",
			FirstKeptEntryID: "seerr_event:event-08",
			TokensBefore:     120,
			Details: map[string]any{
				"component": "seerr_recent_events",
				"issue_id":  "42",
			},
		}),
	}

	manager.recordIssuePromptCompactions("42", entries)

	ledgerPath := filepath.Join(dir, "issues", "issue-42.compactions.jsonl")
	stored, err := runtimectx.ReadCompactionEntries(ledgerPath, 0)
	if err != nil {
		t.Fatalf("ReadCompactionEntries() error = %v", err)
	}
	if len(stored) != 1 || stored[0].Summary != entries[0].Summary {
		t.Fatalf("stored compactions = %#v, want %#v", stored, entries)
	}

	data, err := os.ReadFile(filepath.Join(dir, "issues", "issue-42.jsonl"))
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	var trace map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(data))), &trace); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if trace["type"] != "context_compaction" || trace["entry_id"] != entries[0].ID {
		t.Fatalf("trace = %#v", trace)
	}
}

func testConfig(baseURL, threadDir string) config.Config {
	return config.Config{
		SeerrBaseURL:        baseURL,
		SeerrAPIKey:         "secret",
		SeerrBotDisplayName: "Blitzcrank",
		PiModels:            map[string]string{"default": "gpt-5.5"},
		ThreadsDirectory:    threadDir,
		RunTimeout:          time.Minute,
	}
}

func issuePayload(notificationType, actor, message string) map[string]any {
	return map[string]any{
		"notification_type": notificationType,
		"event":             notificationType,
		"subject":           notificationType,
		"issue": map[string]any{
			"issue_id":            "42",
			"reportedBy_username": "alice",
		},
		"comment": map[string]any{
			"comment_message":      message,
			"commentedBy_username": actor,
		},
	}
}
