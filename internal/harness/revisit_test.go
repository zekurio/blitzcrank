package harness

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"blitzcrank/internal/config"
	"blitzcrank/internal/store"
	"blitzcrank/internal/tools"
)

func TestRevisitDue(t *testing.T) {
	now := time.Date(2026, 7, 5, 12, 0, 0, 0, time.UTC)
	past := now.Add(-time.Minute)
	future := now.Add(time.Minute)
	manager := NewManager(config.Config{SeerrRevisitMax: 2}, &fakeRunner{}, nil, nil)

	tests := []struct {
		name   string
		thread *IssueThread
		want   bool
	}{
		{
			name: "no schedule is never due regardless of age",
			thread: &IssueThread{
				Status:    "active",
				UpdatedAt: now.Add(-24 * time.Hour),
				Events:    []ThreadEvent{{Type: "reported"}},
			},
			want: false,
		},
		{
			name: "schedule in future is not due",
			thread: &IssueThread{
				Status:        "active",
				NextRevisitAt: &future,
				Events:        []ThreadEvent{{Type: "reported"}},
			},
			want: false,
		},
		{
			name: "due schedule on active thread is due",
			thread: &IssueThread{
				Status:        "active",
				NextRevisitAt: &past,
				Events:        []ThreadEvent{{Type: "reported"}},
			},
			want: true,
		},
		{
			name: "completed thread is not due",
			thread: &IssueThread{
				Status:        "completed",
				NextRevisitAt: &past,
				Events:        []ThreadEvent{{Type: "reported"}},
			},
			want: false,
		},
		{
			name: "trailing revisit count at max is not due",
			thread: &IssueThread{
				Status:        "active",
				NextRevisitAt: &past,
				Events:        []ThreadEvent{{Type: "reported"}, {Type: "revisit"}, {Type: "revisit"}},
			},
			want: false,
		},
		{
			name: "non revisit tail event resets trailing count",
			thread: &IssueThread{
				Status:        "active",
				NextRevisitAt: &past,
				Events:        []ThreadEvent{{Type: "reported"}, {Type: "revisit"}, {Type: "revisit"}, {Type: "comment"}},
			},
			want: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := manager.revisitDue(tt.thread, now); got != tt.want {
				t.Fatalf("revisitDue() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestTrailingRevisitEvents(t *testing.T) {
	tests := []struct {
		name   string
		events []ThreadEvent
		want   int
	}{
		{
			name:   "empty event list",
			events: nil,
			want:   0,
		},
		{
			name:   "non revisit tail",
			events: []ThreadEvent{{Type: "reported"}, {Type: "comment"}},
			want:   0,
		},
		{
			name:   "consecutive tail revisits",
			events: []ThreadEvent{{Type: "reported"}, {Type: "revisit"}, {Type: "revisit"}},
			want:   2,
		},
		{
			name:   "non revisit event before tail resets earlier revisits",
			events: []ThreadEvent{{Type: "revisit"}, {Type: "comment"}, {Type: "revisit"}},
			want:   1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := trailingRevisitEvents(tt.events); got != tt.want {
				t.Fatalf("trailingRevisitEvents() = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestIssuePromptContextRevisitInstructions(t *testing.T) {
	manager := NewManager(config.Config{}, &fakeRunner{}, nil, nil)
	thread := &IssueThread{
		IssueID:       "42",
		Status:        "active",
		RevisitReason: "encode still running",
		Events:        []ThreadEvent{{Type: "reported"}},
	}
	payload := map[string]any{"message": "file is stuck"}

	tests := []struct {
		name       string
		event      string
		want       []string
		wantAbsent string
	}{
		{
			name:       "revisit uses scheduled revisit instructions with recorded reason",
			event:      "revisit",
			want:       []string{"revisit you scheduled earlier", "encode still running"},
			wantAbsent: "Use the Pi system prompt",
		},
		{
			name:       "reported event keeps default instructions",
			event:      "reported",
			want:       []string{"Use the Pi system prompt"},
			wantAbsent: "revisit you scheduled earlier",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			prompt := manager.issuePromptContext(thread, payload, tt.event).Content
			for _, want := range tt.want {
				if !strings.Contains(prompt, want) {
					t.Fatalf("prompt missing %q:\n%s", want, prompt)
				}
			}
			if strings.Contains(prompt, tt.wantAbsent) {
				t.Fatalf("prompt unexpectedly contains %q:\n%s", tt.wantAbsent, prompt)
			}
		})
	}
}

func TestParseIssueRunDecision(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want issueRunDecision
	}{
		{
			name: "single line no directive produces no action",
			in:   "RESOLVE_ISSUE: no",
			want: issueRunDecision{Action: "none", ResolveIssue: false, Comment: ""},
		},
		{
			name: "single line yes directive produces no action",
			in:   "RESOLVE_ISSUE: yes",
			want: issueRunDecision{Action: "none", ResolveIssue: true, Comment: ""},
		},
		{
			name: "directive with revisit in then reason posts and schedules",
			in:   "RESOLVE_ISSUE: no\nREVISIT_IN: 30m\nREVISIT_REASON: encode still running\n\nUpdate.",
			want: issueRunDecision{
				Action:        "post",
				ResolveIssue:  false,
				Comment:       "Update.",
				RevisitIn:     30 * time.Minute,
				RevisitReason: "encode still running",
			},
		},
		{
			name: "directive with reason before revisit in resolves and schedules",
			in:   "resolve_issue: TRUE\nREVISIT_REASON: verify import finished\nREVISIT_IN: 1h\n\nBehoben.",
			want: issueRunDecision{
				Action:        "post",
				ResolveIssue:  true,
				Comment:       "Behoben.",
				RevisitIn:     time.Hour,
				RevisitReason: "verify import finished",
			},
		},
		{
			name: "invalid revisit duration is ignored but reason is retained",
			in:   "RESOLVE_ISSUE: false\nREVISIT_IN: eventually\nREVISIT_REASON: still waiting\n\nNo update yet.",
			want: issueRunDecision{
				Action:        "post",
				ResolveIssue:  false,
				Comment:       "No update yet.",
				RevisitReason: "still waiting",
			},
		},
		{
			name: "zero revisit duration is ignored",
			in:   "RESOLVE_ISSUE: no\nREVISIT_IN: 0s\nREVISIT_REASON: no delay\n\nNo update yet.",
			want: issueRunDecision{
				Action:        "post",
				ResolveIssue:  false,
				Comment:       "No update yet.",
				RevisitReason: "no delay",
			},
		},
		{
			name: "negative revisit duration is ignored",
			in:   "RESOLVE_ISSUE: no\nREVISIT_IN: -5m\nREVISIT_REASON: backwards\n\nNo update yet.",
			want: issueRunDecision{
				Action:        "post",
				ResolveIssue:  false,
				Comment:       "No update yet.",
				RevisitReason: "backwards",
			},
		},
		{
			name: "blank line stops directives before comment-like label",
			in:   "RESOLVE_ISSUE: no\n\nFoo: bar",
			want: issueRunDecision{Action: "post", ResolveIssue: false, Comment: "Foo: bar"},
		},
		{
			name: "multi line yes directive posts and resolves",
			in:   "RESOLVE_ISSUE: yes\n\nBehoben.",
			want: issueRunDecision{Action: "post", ResolveIssue: true, Comment: "Behoben."},
		},
		{
			name: "multi line no directive posts without resolving",
			in:   "RESOLVE_ISSUE: no\n\nStatus aktualisiert.",
			want: issueRunDecision{Action: "post", ResolveIssue: false, Comment: "Status aktualisiert."},
		},
		{
			name: "non directive response is a plain comment",
			in:   "Ich habe die Warteschlange geprüft.",
			want: issueRunDecision{Action: "post", ResolveIssue: false, Comment: "Ich habe die Warteschlange geprüft."},
		},
		{
			name: "reason only parses reason without scheduling",
			in:   "RESOLVE_ISSUE: no\nREVISIT_REASON: still downloading",
			want: issueRunDecision{Action: "none", ResolveIssue: false, RevisitReason: "still downloading"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseIssueRunDecision(tt.in)
			if got != tt.want {
				t.Fatalf("parseIssueRunDecision() = %#v, want %#v", got, tt.want)
			}
		})
	}
}

func TestRevisitSweepAppliesAgentScheduledDecisions(t *testing.T) {
	tests := []struct {
		name                 string
		reply                string
		wantComments         int
		wantCommentContains  string
		wantResolvedRequests int
		wantStatus           string
		wantCompletionReason string
		wantSchedule         bool
		wantRevisitReason    string
		wantPosted           bool
		wantRunReason        string
	}{
		{
			name:                 "re-arms from revisit directives and posts update",
			reply:                "RESOLVE_ISSUE: no\nREVISIT_IN: 30m\nREVISIT_REASON: encode still running\n\nUpdate.",
			wantComments:         1,
			wantCommentContains:  "Update.",
			wantResolvedRequests: 0,
			wantStatus:           "active",
			wantSchedule:         true,
			wantRevisitReason:    "encode still running",
			wantPosted:           true,
			wantRunReason:        "final comment posted",
		},
		{
			name:                 "resolve directive posts comment completes thread and clears schedule",
			reply:                "RESOLVE_ISSUE: yes\n\nBehoben.",
			wantComments:         1,
			wantCommentContains:  "Behoben.",
			wantResolvedRequests: 1,
			wantStatus:           "completed",
			wantCompletionReason: "issue resolved after revisit",
			wantSchedule:         false,
			wantPosted:           true,
			wantRunReason:        "final comment posted and issue resolved",
		},
		{
			name:                 "comment without revisit clears schedule and leaves thread active",
			reply:                "RESOLVE_ISSUE: no\n\nDone but confirm please? Alles ok?",
			wantComments:         1,
			wantCommentContains:  "Done but confirm please? Alles ok?",
			wantResolvedRequests: 0,
			wantStatus:           "active",
			wantSchedule:         false,
			wantPosted:           true,
			wantRunReason:        "final comment posted",
		},
		{
			name:              "silent re-arm posts nothing and updates schedule",
			reply:             "RESOLVE_ISSUE: no\nREVISIT_IN: 1h\nREVISIT_REASON: still downloading",
			wantComments:      0,
			wantStatus:        "active",
			wantSchedule:      true,
			wantRevisitReason: "still downloading",
			wantPosted:        false,
			wantRunReason:     "no public update needed",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			server, recorder := newRevisitSeerrServer(t)
			defer server.Close()

			state := openRevisitStore(t, ctx)
			defer state.Close()
			scheduledAt := time.Now().UTC().Add(-time.Minute)
			seedReason := "encoding queue was still running"
			seedStoredRevisitThread(
				t,
				ctx,
				state,
				"42",
				"active",
				scheduledAt,
				&scheduledAt,
				seedReason,
				[]ThreadEvent{reportedRevisitSeedEvent(scheduledAt.Add(-time.Minute))},
			)

			cfg := revisitTestConfig(server.URL)
			runner := &fakeRunner{reply: tt.reply}
			manager := NewManager(cfg, runner, tools.NewRegistry(cfg), state)
			manager.SetIssueResolutionReviewer(&fakeIssueResolutionReviewer{decision: IssueResolutionDecision{Verdict: "approve"}})
			beforeSweep := time.Now().UTC()

			manager.RevisitSweep(ctx)

			if runner.calls != 1 {
				t.Fatalf("runner calls = %d, want 1", runner.calls)
			}
			if len(runner.requests) != 1 {
				t.Fatalf("runner requests = %d, want 1", len(runner.requests))
			}
			request := runner.requests[0]
			if request.Source != "seerr_issue_revisit" {
				t.Fatalf("request Source = %q, want seerr_issue_revisit", request.Source)
			}
			for _, want := range []string{"revisit you scheduled earlier", seedReason} {
				if !strings.Contains(request.Content, want) {
					t.Fatalf("request prompt missing %q:\n%s", want, request.Content)
				}
			}

			comments, resolved, deleted := recorder.snapshot()
			if len(comments) != tt.wantComments {
				t.Fatalf("posted comments = %d, want %d: %#v", len(comments), tt.wantComments, comments)
			}
			if tt.wantCommentContains != "" {
				if len(comments) == 0 || !strings.Contains(comments[0], tt.wantCommentContains) {
					t.Fatalf("posted comments = %#v, want one containing %q", comments, tt.wantCommentContains)
				}
				if strings.Contains(comments[0], "RESOLVE_ISSUE") || strings.Contains(comments[0], "REVISIT_IN") {
					t.Fatalf("posted comment leaked directive: %q", comments[0])
				}
			}
			if resolved != tt.wantResolvedRequests {
				t.Fatalf("resolve requests = %d, want %d", resolved, tt.wantResolvedRequests)
			}
			if deleted != 0 {
				t.Fatalf("delete requests = %d, want 0", deleted)
			}

			thread := loadStoredRevisitThread(t, ctx, state, "42")
			if thread.Status != tt.wantStatus {
				t.Fatalf("thread status = %q, want %q", thread.Status, tt.wantStatus)
			}
			if thread.CompletionReason != tt.wantCompletionReason {
				t.Fatalf("thread completion reason = %q, want %q", thread.CompletionReason, tt.wantCompletionReason)
			}
			if tt.wantSchedule {
				if thread.NextRevisitAt == nil {
					t.Fatal("thread NextRevisitAt = nil, want future schedule")
				}
				if !thread.NextRevisitAt.After(beforeSweep) {
					t.Fatalf("thread NextRevisitAt = %s, want after %s", thread.NextRevisitAt, beforeSweep)
				}
				if thread.RevisitReason != tt.wantRevisitReason {
					t.Fatalf("thread RevisitReason = %q, want %q", thread.RevisitReason, tt.wantRevisitReason)
				}
			} else {
				if thread.NextRevisitAt != nil {
					t.Fatalf("thread NextRevisitAt = %s, want nil", thread.NextRevisitAt)
				}
				if thread.RevisitReason != "" {
					t.Fatalf("thread RevisitReason = %q, want empty", thread.RevisitReason)
				}
			}
			if len(thread.Events) != 2 {
				t.Fatalf("stored events = %d, want reported + revisit: %#v", len(thread.Events), thread.Events)
			}
			lastEvent := thread.Events[len(thread.Events)-1]
			if lastEvent.EventType != "revisit" || lastEvent.Actor != "blitzcrank" {
				t.Fatalf("last event = %#v, want blitzcrank revisit", lastEvent)
			}
			if len(thread.Runs) != 1 {
				t.Fatalf("stored runs = %d, want 1: %#v", len(thread.Runs), thread.Runs)
			}
			run := thread.Runs[0]
			if run.SourceEventType != "revisit" {
				t.Fatalf("run source_event_type = %q, want revisit", run.SourceEventType)
			}
			if run.CompletionReason != tt.wantRunReason {
				t.Fatalf("run completion reason = %q, want %q", run.CompletionReason, tt.wantRunReason)
			}
			if run.Posted != tt.wantPosted {
				t.Fatalf("run Posted = %v, want %v", run.Posted, tt.wantPosted)
			}
		})
	}
}

func TestRevisitSweepRunErrorRecordsRunWithoutAppendingEvent(t *testing.T) {
	ctx := context.Background()
	server, recorder := newRevisitSeerrServer(t)
	defer server.Close()

	state := openRevisitStore(t, ctx)
	defer state.Close()
	scheduledAt := time.Now().UTC().Add(-time.Minute)
	seedReason := "verify encoding after worker restart"
	seedStoredRevisitThread(
		t,
		ctx,
		state,
		"42",
		"active",
		scheduledAt,
		&scheduledAt,
		seedReason,
		[]ThreadEvent{reportedRevisitSeedEvent(scheduledAt.Add(-time.Minute))},
	)

	cfg := revisitTestConfig(server.URL)
	runner := &fakeRunner{err: errors.New("agent failed")}
	manager := NewManager(cfg, runner, tools.NewRegistry(cfg), state)
	beforeSweep := time.Now().UTC()

	manager.RevisitSweep(ctx)

	if runner.calls != 1 {
		t.Fatalf("runner calls = %d, want 1", runner.calls)
	}
	comments, resolved, deleted := recorder.snapshot()
	if len(comments) != 0 || resolved != 0 || deleted != 0 {
		t.Fatalf("seerr calls comments=%#v resolved=%d deleted=%d, want none", comments, resolved, deleted)
	}
	thread := loadStoredRevisitThread(t, ctx, state, "42")
	if thread.Status != "active" {
		t.Fatalf("thread status = %q, want active", thread.Status)
	}
	if len(thread.Events) != 1 || thread.Events[0].EventType != "reported" {
		t.Fatalf("events = %#v, want only original reported event", thread.Events)
	}
	if thread.NextRevisitAt == nil {
		t.Fatal("thread NextRevisitAt = nil, want retry schedule")
	}
	if !thread.NextRevisitAt.After(beforeSweep.Add(29 * time.Minute)) {
		t.Fatalf("thread NextRevisitAt = %s, want about 30m after %s", thread.NextRevisitAt, beforeSweep)
	}
	if thread.NextRevisitAt.After(time.Now().UTC().Add(31 * time.Minute)) {
		t.Fatalf("thread NextRevisitAt = %s, want within about 30m", thread.NextRevisitAt)
	}
	if thread.RevisitReason != seedReason {
		t.Fatalf("thread RevisitReason = %q, want %q", thread.RevisitReason, seedReason)
	}
	if len(thread.Runs) != 1 {
		t.Fatalf("stored runs = %d, want 1: %#v", len(thread.Runs), thread.Runs)
	}
	run := thread.Runs[0]
	if run.SourceEventType != "revisit" {
		t.Fatalf("run source_event_type = %q, want revisit", run.SourceEventType)
	}
	if run.CompletionReason != "agent run failed" {
		t.Fatalf("run completion reason = %q, want agent run failed", run.CompletionReason)
	}
	if !strings.Contains(run.Error, "agent failed") {
		t.Fatalf("run error = %q, want it to mention agent failed", run.Error)
	}
}

func TestRevisitSweepSkipsTrailingRevisitsAtMax(t *testing.T) {
	ctx := context.Background()
	server, recorder := newRevisitSeerrServer(t)
	defer server.Close()

	state := openRevisitStore(t, ctx)
	defer state.Close()
	scheduledAt := time.Now().UTC().Add(-time.Minute)
	seedStoredRevisitThread(t, ctx, state, "42", "active", scheduledAt, &scheduledAt, "still pending", []ThreadEvent{
		reportedRevisitSeedEvent(scheduledAt.Add(-3 * time.Minute)),
		{Type: "revisit", Key: "revisit-1", Actor: "blitzcrank", At: scheduledAt.Add(-2 * time.Minute)},
		{Type: "revisit", Key: "revisit-2", Actor: "blitzcrank", At: scheduledAt.Add(-time.Minute)},
	})

	cfg := revisitTestConfig(server.URL)
	runner := &fakeRunner{reply: "RESOLVE_ISSUE: no\n\nStatus aktualisiert."}
	manager := NewManager(cfg, runner, tools.NewRegistry(cfg), state)

	manager.RevisitSweep(ctx)

	if runner.calls != 0 {
		t.Fatalf("runner calls = %d, want 0", runner.calls)
	}
	comments, resolved, deleted := recorder.snapshot()
	if len(comments) != 0 || resolved != 0 || deleted != 0 {
		t.Fatalf("seerr calls comments=%#v resolved=%d deleted=%d, want none", comments, resolved, deleted)
	}
}

type revisitSeerrRecorder struct {
	mu       sync.Mutex
	comments []string
	resolved int
	deleted  int
}

func newRevisitSeerrServer(t *testing.T) (*httptest.Server, *revisitSeerrRecorder) {
	t.Helper()
	recorder := &revisitSeerrRecorder{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Helper()
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/issue/42/comment":
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			recorder.mu.Lock()
			recorder.comments = append(recorder.comments, body["message"])
			recorder.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":42,"comments":[{"id":"comment-1"}]}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/issue/42/resolved":
			recorder.mu.Lock()
			recorder.resolved++
			recorder.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/issue/42":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"status":2}`))
		case r.Method == http.MethodDelete && r.URL.Path == "/api/v1/issueComment/comment-1":
			recorder.mu.Lock()
			recorder.deleted++
			recorder.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	return server, recorder
}

func (r *revisitSeerrRecorder) snapshot() ([]string, int, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.comments...), r.resolved, r.deleted
}

func revisitTestConfig(baseURL string) config.Config {
	cfg := testConfig(baseURL, "")
	cfg.SeerrRevisitsEnabled = true
	cfg.SeerrRevisitMax = 2
	cfg.SeerrTransientRunComments = false
	return cfg
}

func openRevisitStore(t *testing.T, ctx context.Context) *store.Store {
	t.Helper()
	state, err := store.Open(ctx, filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	return state
}

func seedStoredRevisitThread(
	t *testing.T,
	ctx context.Context,
	state *store.Store,
	issueID string,
	status string,
	updatedAt time.Time,
	nextRevisitAt *time.Time,
	revisitReason string,
	events []ThreadEvent,
) {
	t.Helper()
	lastPayload, err := json.Marshal(map[string]string{"issue_id": issueID})
	if err != nil {
		t.Fatalf("marshal last payload: %v", err)
	}
	if err := state.UpsertIssueThread(ctx, store.IssueThread{
		IssueID:         issueID,
		Status:          status,
		Summary:         "Quiet issue awaiting revisit",
		CreatedAt:       updatedAt.Add(-time.Hour),
		UpdatedAt:       updatedAt,
		NextRevisitAt:   nextRevisitAt,
		RevisitReason:   revisitReason,
		LastPayloadJSON: string(lastPayload),
	}); err != nil {
		t.Fatalf("UpsertIssueThread() error = %v", err)
	}
	for i, event := range events {
		payload := event.Payload
		if len(payload) == 0 {
			payload, err = json.Marshal(map[string]string{"event": event.Type})
			if err != nil {
				t.Fatalf("marshal event payload: %v", err)
			}
		}
		key := event.Key
		if key == "" {
			key = fmt.Sprintf("%s-%d", event.Type, i)
		}
		createdAt := event.At
		if createdAt.IsZero() {
			createdAt = updatedAt.Add(time.Duration(i) * time.Second)
		}
		if err := state.InsertIssueEvent(ctx, store.IssueEvent{
			IssueID:     issueID,
			EventKey:    key,
			EventType:   event.Type,
			Actor:       event.Actor,
			PayloadJSON: string(payload),
			CreatedAt:   createdAt,
		}); err != nil {
			t.Fatalf("InsertIssueEvent(%s) error = %v", key, err)
		}
	}
}

func reportedRevisitSeedEvent(at time.Time) ThreadEvent {
	return ThreadEvent{
		Type:    "reported",
		Key:     "reported-1",
		Actor:   "alice",
		Message: "file is stuck",
		Payload: json.RawMessage(`{"event":"reported","message":"file is stuck"}`),
		At:      at,
	}
}

func loadStoredRevisitThread(t *testing.T, ctx context.Context, state *store.Store, issueID string) store.IssueThread {
	t.Helper()
	thread, ok, err := state.LoadIssueThread(ctx, issueID)
	if err != nil {
		t.Fatalf("LoadIssueThread() error = %v", err)
	}
	if !ok {
		t.Fatalf("LoadIssueThread(%q) ok = false", issueID)
	}
	return thread
}
