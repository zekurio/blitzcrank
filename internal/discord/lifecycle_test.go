package discord

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"blitzcrank/internal/config"
	"blitzcrank/internal/harness"
	"blitzcrank/internal/store"

	"github.com/bwmarrin/discordgo"
)

// lifecycleLog records ordered retention side effects so tests can assert that
// a private Pi session is destroyed before the ownership metadata that names it.
type lifecycleLog struct {
	mu     sync.Mutex
	events []string
}

func (l *lifecycleLog) record(event string) {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.events = append(l.events, event)
}

func (l *lifecycleLog) snapshot() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.events...)
}

// sessionConversationRunner is a runner that also owns source-isolated Discord
// Pi sessions, matching the production *pi.Runner.
type sessionConversationRunner struct {
	*recordingConversationRunner
	lifecycle *lifecycleLog
	deleteErr error
}

func (r *sessionConversationRunner) DeleteDiscordSession(_ context.Context, threadID string) error {
	if r.deleteErr != nil {
		return r.deleteErr
	}
	r.lifecycle.record("delete-session:" + threadID)
	return nil
}

func silentRunner() *recordingConversationRunner {
	return &recordingConversationRunner{respond: func(context.Context, harness.Request) (string, error) {
		return "ok", nil
	}}
}

func lifecycleAgent(t *testing.T, runner ConversationRunner, state *fakeConversationStore, api discordAPI, now time.Time) *conversationAgent {
	t.Helper()
	return newConversationAgent(testConversationConfig(), runner, state, api, func() time.Time { return now })
}

func idleConversation(threadID, ownerID string, updatedAt time.Time) store.DiscordConversation {
	return store.DiscordConversation{
		ThreadID:         threadID,
		ParentChannelID:  "public",
		OwnerID:          ownerID,
		TriggerMessageID: "trigger",
		Route:            "private",
		Category:         "support",
		Status:           store.DiscordConversationActive,
		CreatedAt:        updatedAt,
		UpdatedAt:        updatedAt,
	}
}

func registerWorker(agent *conversationAgent, conversation store.DiscordConversation) *conversationWorker {
	worker := &conversationWorker{
		agent:        agent,
		conversation: conversation,
		messages:     make(chan ownerMessage, 4),
		stop:         make(chan struct{}),
	}
	agent.workers[conversation.ThreadID] = worker
	return worker
}

func TestMaintenanceArchivesIdleConversationAndRetiresWorkerKeepingOwnership(t *testing.T) {
	now := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
	lastActivity := now.Add(-48 * time.Hour)
	state := newFakeConversationStore()
	conversation := idleConversation("thread", "owner", lastActivity)
	state.conversations["thread"] = conversation
	agent := lifecycleAgent(t, silentRunner(), state, &fakeDiscordAPI{botUserID: "bot"}, now)
	agent.conversations["thread"] = conversation
	worker := registerWorker(agent, conversation)

	if err := agent.maintainConversations(context.Background()); err != nil {
		t.Fatalf("maintainConversations() error = %v", err)
	}

	select {
	case <-worker.stop:
	default:
		t.Error("idle worker was not retired")
	}
	if _, ok := agent.workers["thread"]; ok {
		t.Error("retired worker stayed registered")
	}

	memory := agent.conversations["thread"]
	state.mu.Lock()
	persisted := state.conversations["thread"]
	state.mu.Unlock()
	if memory.Status != store.DiscordConversationArchived || persisted.Status != store.DiscordConversationArchived {
		t.Fatalf("status memory=%q sqlite=%q, want archived in both", memory.Status, persisted.Status)
	}
	if !memory.UpdatedAt.Equal(persisted.UpdatedAt) {
		t.Errorf("UpdatedAt memory=%v sqlite=%v, want identical", memory.UpdatedAt, persisted.UpdatedAt)
	}
	// Retention is measured from the owner's last activity, not from archival.
	if !memory.UpdatedAt.Equal(lastActivity) {
		t.Errorf("archived UpdatedAt = %v, want last owner activity %v", memory.UpdatedAt, lastActivity)
	}
	if memory.OwnerID != "owner" || persisted.OwnerID != "owner" {
		t.Errorf("archiving lost ownership: memory=%q sqlite=%q", memory.OwnerID, persisted.OwnerID)
	}
}

func TestMaintenanceNeverRetiresOrDeletesLiveWork(t *testing.T) {
	now := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
	expired := now.Add(-40 * 24 * time.Hour)

	tests := []struct {
		name    string
		status  string
		prepare func(*conversationWorker)
	}{
		{name: "busy active conversation", status: store.DiscordConversationActive, prepare: func(w *conversationWorker) { w.busy = true }},
		{name: "queued active conversation", status: store.DiscordConversationActive, prepare: func(w *conversationWorker) {
			w.messages <- ownerMessage{ID: "queued"}
		}},
		{name: "expired archived conversation with reattached worker", status: store.DiscordConversationArchived, prepare: func(*conversationWorker) {}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			state := newFakeConversationStore()
			lifecycle := &lifecycleLog{}
			state.lifecycle = lifecycle
			conversation := idleConversation("thread", "owner", expired)
			conversation.Status = tt.status
			state.conversations["thread"] = conversation
			runner := &sessionConversationRunner{recordingConversationRunner: silentRunner(), lifecycle: lifecycle}
			agent := lifecycleAgent(t, runner, state, &fakeDiscordAPI{botUserID: "bot"}, now)
			agent.conversations["thread"] = conversation
			worker := registerWorker(agent, conversation)
			tt.prepare(worker)

			if err := agent.maintainConversations(context.Background()); err != nil {
				t.Fatalf("maintainConversations() error = %v", err)
			}

			select {
			case <-worker.stop:
				t.Fatal("live worker was retired")
			default:
			}
			if _, ok := agent.workers["thread"]; !ok {
				t.Error("live worker was unregistered")
			}
			state.mu.Lock()
			_, persisted := state.conversations["thread"]
			state.mu.Unlock()
			if !persisted {
				t.Error("conversation with live work was deleted")
			}
			if events := lifecycle.snapshot(); len(events) != 0 {
				t.Errorf("retention touched live work: %v", events)
			}
		})
	}
}

func TestMaintenanceDeletesPrivateSessionBeforeOwnershipMetadata(t *testing.T) {
	now := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
	state := newFakeConversationStore()
	lifecycle := &lifecycleLog{}
	state.lifecycle = lifecycle
	conversation := idleConversation("thread", "owner", now.Add(-40*24*time.Hour))
	conversation.Status = store.DiscordConversationArchived
	state.conversations["thread"] = conversation
	runner := &sessionConversationRunner{recordingConversationRunner: silentRunner(), lifecycle: lifecycle}
	agent := lifecycleAgent(t, runner, state, &fakeDiscordAPI{botUserID: "bot"}, now)
	agent.conversations["thread"] = conversation

	if err := agent.maintainConversations(context.Background()); err != nil {
		t.Fatalf("maintainConversations() error = %v", err)
	}

	want := []string{"delete-session:thread", "delete-conversation:thread"}
	got := lifecycle.snapshot()
	if len(got) != len(want) {
		t.Fatalf("retention events = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("retention order = %v, want %v", got, want)
		}
	}
	if _, ok := agent.conversations["thread"]; ok {
		t.Error("expired conversation stayed in memory")
	}
	state.mu.Lock()
	_, persisted := state.conversations["thread"]
	state.mu.Unlock()
	if persisted {
		t.Error("expired conversation stayed in sqlite")
	}
}

func TestMaintenanceRetainsMetadataWhenSessionDeletionIsUnavailableOrFails(t *testing.T) {
	now := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
	expired := now.Add(-40 * 24 * time.Hour)

	t.Run("no session manager", func(t *testing.T) {
		state := newFakeConversationStore()
		state.lifecycle = &lifecycleLog{}
		conversation := idleConversation("thread", "owner", expired)
		conversation.Status = store.DiscordConversationArchived
		state.conversations["thread"] = conversation
		agent := lifecycleAgent(t, silentRunner(), state, &fakeDiscordAPI{botUserID: "bot"}, now)
		agent.conversations["thread"] = conversation

		if err := agent.maintainConversations(context.Background()); err != nil {
			t.Fatalf("maintainConversations() error = %v", err)
		}
		state.mu.Lock()
		_, persisted := state.conversations["thread"]
		state.mu.Unlock()
		if !persisted {
			t.Error("ownership metadata was orphaned from its private session")
		}
	})

	t.Run("session deletion fails", func(t *testing.T) {
		state := newFakeConversationStore()
		lifecycle := &lifecycleLog{}
		state.lifecycle = lifecycle
		conversation := idleConversation("thread", "owner", expired)
		conversation.Status = store.DiscordConversationArchived
		state.conversations["thread"] = conversation
		runner := &sessionConversationRunner{
			recordingConversationRunner: silentRunner(),
			lifecycle:                   lifecycle,
			deleteErr:                   errors.New("disk failure"),
		}
		agent := lifecycleAgent(t, runner, state, &fakeDiscordAPI{botUserID: "bot"}, now)
		agent.conversations["thread"] = conversation

		if err := agent.maintainConversations(context.Background()); err == nil {
			t.Fatal("maintainConversations() error = nil, want session deletion failure")
		}
		state.mu.Lock()
		_, persisted := state.conversations["thread"]
		state.mu.Unlock()
		if !persisted {
			t.Error("metadata was deleted after its session deletion failed")
		}
	})
}

func TestArchivedConversationReactivatesOnOwnerMessageWithinRetention(t *testing.T) {
	now := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
	state := newFakeConversationStore()
	state.lifecycle = &lifecycleLog{}
	conversation := idleConversation("thread", "owner", now.Add(-48*time.Hour))
	conversation.Status = store.DiscordConversationArchived
	state.conversations["thread"] = conversation
	api := &fakeDiscordAPI{botUserID: "bot", sentNotify: make(chan struct{}, 2)}
	runner := &recordingConversationRunner{respond: func(_ context.Context, request harness.Request) (string, error) {
		if request.Source != "discord_thread" {
			return "", errors.New("archived owner message must not be re-triaged")
		}
		return "willkommen zurück", nil
	}}
	agent := lifecycleAgent(t, runner, state, api, now)
	agent.cfg.DiscordDebounce = time.Millisecond
	agent.conversations["thread"] = conversation
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		cancel()
		agent.stop()
		agent.wait()
	})

	if err := agent.handleMessage(ctx, testDiscordMessage("resume", "thread", "owner", "bist du noch da?")); err != nil {
		t.Fatalf("handleMessage() error = %v", err)
	}
	waitForSignal(t, api.sentNotify)

	agent.mu.Lock()
	memory := agent.conversations["thread"]
	agent.mu.Unlock()
	state.mu.Lock()
	persisted := state.conversations["thread"]
	state.mu.Unlock()
	if memory.Status != store.DiscordConversationActive || persisted.Status != store.DiscordConversationActive {
		t.Fatalf("status memory=%q sqlite=%q, want active in both", memory.Status, persisted.Status)
	}
	if !memory.UpdatedAt.Equal(now) || !persisted.UpdatedAt.Equal(now) {
		t.Errorf("UpdatedAt memory=%v sqlite=%v, want refreshed to %v", memory.UpdatedAt, persisted.UpdatedAt, now)
	}
	if memory.OwnerID != "owner" {
		t.Errorf("owner = %q, want preserved across reactivation", memory.OwnerID)
	}
	if requests := runner.snapshot(); len(requests) != 1 || requests[0].ThreadID != "thread" {
		t.Fatalf("reactivated requests = %+v, want one thread run", requests)
	}
}

func TestArchivedConversationIgnoresNonOwnerAndDuplicateMessages(t *testing.T) {
	now := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
	state := newFakeConversationStore()
	state.lifecycle = &lifecycleLog{}
	archived := idleConversation("thread", "owner", now.Add(-48*time.Hour))
	archived.Status = store.DiscordConversationArchived
	state.conversations["thread"] = archived
	state.messages["seen"] = store.DiscordMessage{MessageID: "seen", ChannelID: "thread", AuthorID: "owner", Status: store.DiscordStatusInterrupted}
	runner := &recordingConversationRunner{respond: func(context.Context, harness.Request) (string, error) {
		return "", errors.New("no run expected")
	}}
	agent := lifecycleAgent(t, runner, state, &fakeDiscordAPI{botUserID: "bot"}, now)
	agent.conversations["thread"] = archived

	if err := agent.handleMessage(context.Background(), testDiscordMessage("outsider", "thread", "moderator", "hallo")); err != nil {
		t.Fatalf("outsider handleMessage() error = %v", err)
	}
	// A redelivery of an already claimed message must not resurrect the thread.
	if err := agent.handleMessage(context.Background(), testDiscordMessage("seen", "thread", "owner", "hallo")); err != nil {
		t.Fatalf("duplicate handleMessage() error = %v", err)
	}

	agent.mu.Lock()
	memory := agent.conversations["thread"]
	agent.mu.Unlock()
	if memory.Status != store.DiscordConversationArchived {
		t.Errorf("status = %q, want archived", memory.Status)
	}
	if got := len(runner.snapshot()); got != 0 {
		t.Errorf("runner requests = %d, want none", got)
	}
}

func TestExitedWorkerUnregistersItself(t *testing.T) {
	now := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
	state := newFakeConversationStore()
	state.lifecycle = &lifecycleLog{}
	conversation := idleConversation("thread", "owner", now)
	agent := lifecycleAgent(t, silentRunner(), state, &fakeDiscordAPI{botUserID: "bot"}, now)
	agent.conversations["thread"] = conversation
	worker := registerWorker(agent, conversation)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	agent.tasks.goRun(func() {
		worker.loop(ctx)
		close(done)
	})
	cancel()
	waitForSignal(t, done)

	agent.mu.Lock()
	_, registered := agent.workers["thread"]
	agent.mu.Unlock()
	if registered {
		t.Error("exited worker stayed registered and would swallow future messages")
	}
	agent.stop()
	agent.wait()
}

func TestMaintenanceLoopStopsOnRootContextCancellation(t *testing.T) {
	now := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
	state := newFakeConversationStore()
	state.lifecycle = &lifecycleLog{}
	agent := lifecycleAgent(t, silentRunner(), state, &fakeDiscordAPI{botUserID: "bot"}, now)
	agent.cfg.DiscordThreadInactivity = 2 * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	agent.start(ctx, 1, 1)
	cancel()

	done := make(chan struct{})
	go func() {
		agent.stop()
		agent.wait()
		close(done)
	}()
	waitForSignal(t, done)

	if err := agent.maintainConversations(ctx); !errors.Is(err, context.Canceled) {
		t.Errorf("maintainConversations(canceled) error = %v, want context.Canceled", err)
	}
}

func TestRecoveryRetriesOnlyMessagesClaimedBeforeTheirRunBegan(t *testing.T) {
	now := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
	state := newFakeConversationStore()
	state.lifecycle = &lifecycleLog{}
	state.conversations["thread"] = idleConversation("thread", "owner", now)
	// A mutation-capable turn that a restart tore down: anchor plus the message
	// debounced into the same batch.
	state.messages["anchor"] = store.DiscordMessage{MessageID: "anchor", ChannelID: "thread", AuthorID: "owner", Status: store.DiscordMessageRunning}
	state.messages["batched"] = store.DiscordMessage{MessageID: "batched", ChannelID: "thread", AuthorID: "owner", Status: store.DiscordMessageRunning}
	state.runs["run"] = store.DiscordRun{ID: "run", MessageID: "anchor", ThreadID: "thread", Source: "discord_thread", Status: store.DiscordRunRunning}
	// A message claimed at ingress that never reached an agent.
	state.messages["fresh"] = store.DiscordMessage{MessageID: "fresh", ChannelID: "public", AuthorID: "owner", Status: store.DiscordMessageClaimed, ReceivedAt: now.Add(-time.Minute)}

	api := &fakeDiscordAPI{
		botUserID: "bot",
		fetched:   map[string]*discordgo.Message{"public:fresh": testDiscordMessage("fresh", "public", "owner", "nur Smalltalk")},
	}
	runner := &recordingConversationRunner{respond: func(_ context.Context, request harness.Request) (string, error) {
		if request.Source != "discord_triage" {
			return "", errors.New("interrupted turn was replayed")
		}
		return triageJSON("ignore", "general", "de"), nil
	}}
	agent := lifecycleAgent(t, runner, state, api, now)

	if err := agent.recover(context.Background()); err != nil {
		t.Fatalf("recover() error = %v", err)
	}

	requests := runner.snapshot()
	if len(requests) != 1 || requests[0].Source != "discord_triage" || requests[0].RunID != "discord-triage-fresh" {
		t.Fatalf("recovery requests = %+v, want only the unstarted claim retried", requests)
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	for _, id := range []string{"anchor", "batched"} {
		message := state.messages[id]
		if message.Status != store.DiscordStatusInterrupted || message.CompletedAt == nil {
			t.Errorf("message %q = %+v, want terminal interrupted", id, message)
		}
	}
	if run := state.runs["run"]; run.Status != store.DiscordStatusInterrupted || run.CompletedAt == nil {
		t.Errorf("run = %+v, want terminal interrupted", run)
	}
	if fresh := state.messages["fresh"]; fresh.Status != "ignored" || fresh.CompletedAt == nil {
		t.Errorf("fresh message = %+v, want retried to completion", fresh)
	}
}

func TestRecoveryPostsOneSanitizedInterruptionNoticePerThread(t *testing.T) {
	now := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
	secret := "Mein geheimer Film"
	state := newFakeConversationStore()
	state.lifecycle = &lifecycleLog{}
	state.conversations["thread"] = idleConversation("thread", "owner", now)
	state.messages["anchor"] = store.DiscordMessage{MessageID: "anchor", ChannelID: "thread", AuthorID: "owner", Status: store.DiscordMessageRunning}
	state.messages["second"] = store.DiscordMessage{MessageID: "second", ChannelID: "thread", AuthorID: "owner", Status: store.DiscordMessageRunning}
	// Two interrupted runs in the same thread must still yield one notice.
	state.runs["run-a"] = store.DiscordRun{ID: "run-a", MessageID: "anchor", ThreadID: "thread", Source: "discord_thread", Status: store.DiscordRunRunning}
	state.runs["run-b"] = store.DiscordRun{ID: "run-b", MessageID: "second", ThreadID: "thread", Source: "discord_thread", Status: store.DiscordRunRunning}

	api := &fakeDiscordAPI{botUserID: "bot"}
	agent := lifecycleAgent(t, silentRunner(), state, api, now)

	if err := agent.recover(context.Background()); err != nil {
		t.Fatalf("recover() error = %v", err)
	}
	sent := api.snapshotSent()
	if len(sent) != 1 || sent[0].channelID != "thread" {
		t.Fatalf("sent = %+v, want exactly one notice in the private thread", sent)
	}
	content := sent[0].message.Content
	if strings.Contains(content, secret) || strings.Contains(content, "anchor") || strings.Contains(content, "run-a") {
		t.Errorf("interruption notice leaked detail: %q", content)
	}
	if !strings.Contains(content, "erneut") {
		t.Errorf("interruption notice %q does not ask the owner to resend", content)
	}
	if sent[0].message.AllowedMentions == nil || len(sent[0].message.AllowedMentions.Parse) != 0 {
		t.Error("interruption notice does not suppress generated mentions")
	}

	// A second recovery finds no recoverable runs, so no thread is told twice.
	if err := agent.recover(context.Background()); err != nil {
		t.Fatalf("second recover() error = %v", err)
	}
	if got := len(api.snapshotSent()); got != 1 {
		t.Errorf("notices after restart replay = %d, want 1", got)
	}
}

func TestRecoveryStaysSilentWithoutASurvivingPrivateThread(t *testing.T) {
	now := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
	state := newFakeConversationStore()
	state.lifecycle = &lifecycleLog{}
	state.messages["public-anchor"] = store.DiscordMessage{MessageID: "public-anchor", ChannelID: "public", AuthorID: "owner", Status: store.DiscordMessageRunning}
	state.messages["orphan-anchor"] = store.DiscordMessage{MessageID: "orphan-anchor", ChannelID: "gone", AuthorID: "owner", Status: store.DiscordMessageRunning}
	// A direct public run has no thread; an orphaned run names a thread whose
	// ownership metadata is gone. Neither may be announced anywhere.
	state.runs["direct"] = store.DiscordRun{ID: "direct", MessageID: "public-anchor", Source: "discord_direct", Status: store.DiscordRunRunning}
	state.runs["orphan"] = store.DiscordRun{ID: "orphan", MessageID: "orphan-anchor", ThreadID: "gone", Source: "discord_thread", Status: store.DiscordRunRunning}

	api := &fakeDiscordAPI{botUserID: "bot"}
	agent := lifecycleAgent(t, silentRunner(), state, api, now)

	if err := agent.recover(context.Background()); err != nil {
		t.Fatalf("recover() error = %v", err)
	}
	if sent := api.snapshotSent(); len(sent) != 0 {
		t.Fatalf("sent = %+v, want silence without a known private thread", sent)
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	for _, id := range []string{"public-anchor", "orphan-anchor"} {
		if message := state.messages[id]; message.Status != store.DiscordStatusInterrupted {
			t.Errorf("message %q = %+v, want terminal interrupted", id, message)
		}
	}
}

func TestRunStartMovesEveryBatchedMessageOutOfTheRetryableClaim(t *testing.T) {
	now := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
	state := newFakeConversationStore()
	state.lifecycle = &lifecycleLog{}
	conversation := idleConversation("thread", "owner", now)
	state.conversations["thread"] = conversation
	for _, id := range []string{"one", "two"} {
		state.messages[id] = store.DiscordMessage{MessageID: id, ChannelID: "thread", AuthorID: "owner", Status: store.DiscordMessageClaimed}
	}
	api := &fakeDiscordAPI{botUserID: "bot"}
	started := make(chan struct{})
	release := make(chan struct{})
	runner := &recordingConversationRunner{respond: func(context.Context, harness.Request) (string, error) {
		close(started)
		<-release
		return "ok", nil
	}}
	agent := lifecycleAgent(t, runner, state, api, now)
	batch := []ownerMessage{{ID: "one", AuthorID: "owner"}, {ID: "two", AuthorID: "owner"}}
	request := agent.workingRequest("discord_thread", "thread", "private", "support", batch)

	done := make(chan struct{})
	go func() {
		_, _ = agent.runWorkingAgent(context.Background(), request, "thread", nil, batch)
		close(done)
	}()
	waitForSignal(t, started)

	// While the turn runs, no consumed message may look retryable.
	recoverable, err := state.ListRecoverableDiscordMessages(context.Background())
	if err != nil {
		t.Fatalf("ListRecoverableDiscordMessages() error = %v", err)
	}
	if len(recoverable) != 0 {
		t.Errorf("recoverable mid-run messages = %+v, want none", recoverable)
	}
	close(release)
	waitForSignal(t, done)
}

func TestConversationConfigDefaultsKeepInactivityBelowRetention(t *testing.T) {
	cfg := testConversationConfig()
	if cfg.DiscordThreadInactivity >= cfg.DiscordRetention {
		t.Fatalf("inactivity %v must stay below retention %v so archived threads are reactivatable", cfg.DiscordThreadInactivity, cfg.DiscordRetention)
	}
	agent := newConversationAgent(config.Config{}, nil, nil, nil, nil)
	if got := agent.maintenanceInterval(); got < time.Second {
		t.Errorf("maintenanceInterval() = %v, want at least a second", got)
	}
}
