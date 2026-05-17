package harness

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"blitzcrank/internal/agent"
	"blitzcrank/internal/config"
	"blitzcrank/internal/tools"
)

type fakeRunner struct {
	calls int
	reply string
	err   error
	model string
}

func (f *fakeRunner) Respond(_ context.Context, req agent.Request) (string, error) {
	f.calls++
	return f.reply, f.err
}

func (f *fakeRunner) ModelName(agent.Request) string {
	return f.model
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

func (r *retryRunner) Respond(_ context.Context, req agent.Request) (string, error) {
	r.calls++
	if r.calls == 1 {
		return "", errors.New("temporary agent failure")
	}
	return "Erledigt.", nil
}

func (r *observedRunner) Respond(ctx context.Context, req agent.Request) (string, error) {
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

func TestCommentHeaderIncludesFastServiceTier(t *testing.T) {
	cfg := testConfig("http://127.0.0.1.invalid", t.TempDir())
	cfg.CodexServiceTier = "fast"
	manager := NewManager(cfg, &fakeRunner{}, tools.NewRegistry(cfg), nil)

	if got := manager.commentHeader(); got != "[blitzcrank w/ gpt-5.5 fast]" {
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
	manager.recordToolCall("42", "reported", startedAt, agent.ToolAuditRecord{
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

func testConfig(baseURL, threadDir string) config.Config {
	return config.Config{
		SeerrBaseURL:        baseURL,
		SeerrAPIKey:         "secret",
		SeerrBotDisplayName: "Blitzcrank",
		Model:               "gpt-5.5",
		ThreadsDirectory:    threadDir,
		RunTimeout:          time.Minute,
		MaxToolIterations:   2,
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
