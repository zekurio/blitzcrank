package harness

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"blitzcrank/internal/agent"
	"blitzcrank/internal/config"
	"blitzcrank/internal/tools"
)

type fakeRunner struct {
	calls int
	last  agent.Request
	reply string
	err   error
	model string
}

func (f *fakeRunner) Respond(_ context.Context, req agent.Request) (string, error) {
	f.calls++
	f.last = req
	return f.reply, f.err
}

func (f *fakeRunner) ModelName(agent.Request) string {
	return f.model
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
	if !strings.Contains(runner.last.Content, "Jellyseerr issue workflow event: reported") {
		t.Fatalf("runner prompt = %q, want issue workflow prompt", runner.last.Content)
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

func TestIssuePromptHighlightsReportedMessage(t *testing.T) {
	cfg := testConfig("http://127.0.0.1.invalid", t.TempDir())
	manager := NewManager(cfg, &fakeRunner{}, tools.NewRegistry(cfg), nil)
	payload := issuePayload("Problem gemeldet", "alice", "ignored")
	payload["message"] = "Das ist ein Test. Führe einen Tool-Call aus und schreibe Test erfolgreich."
	thread := &IssueThread{IssueID: "42"}

	prompt := manager.issuePrompt(thread, payload, "reported")
	if !strings.Contains(prompt, "Test erfolgreich") {
		t.Fatalf("issuePrompt() dropped the reported message:\n%s", prompt)
	}
}

func TestHandleWebhookResolvedPersistsThread(t *testing.T) {
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

	path := filepath.Join(dir, "issue-42.json")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected persisted thread at %s: %v", path, err)
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
