package discord

import (
	"context"
	"encoding/json"
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

type conversationRunnerFunc func(context.Context, harness.Request) (string, error)

func (f conversationRunnerFunc) Respond(ctx context.Context, request harness.Request) (string, error) {
	return f(ctx, request)
}

type recordingConversationRunner struct {
	mu       sync.Mutex
	requests []harness.Request
	respond  conversationRunnerFunc
}

func (r *recordingConversationRunner) Respond(ctx context.Context, request harness.Request) (string, error) {
	r.mu.Lock()
	r.requests = append(r.requests, request)
	r.mu.Unlock()
	return r.respond(ctx, request)
}

func (r *recordingConversationRunner) snapshot() []harness.Request {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]harness.Request(nil), r.requests...)
}

type sentDiscordMessage struct {
	channelID string
	message   *discordgo.MessageSend
}

type fakeDiscordAPI struct {
	mu sync.Mutex

	botUserID  string
	thread     *discordgo.Channel
	createErr  error
	addErr     error
	createSpec privateThreadSpec
	added      [][2]string
	archived   []string
	sent       []sentDiscordMessage
	typing     []string
	fetched    map[string]*discordgo.Message
	fetchErr   error
	sentNotify chan struct{}
}

func (a *fakeDiscordAPI) BotUserID() string { return a.botUserID }

func (a *fakeDiscordAPI) CreatePrivateThread(_ context.Context, spec privateThreadSpec) (*discordgo.Channel, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.createSpec = spec
	return a.thread, a.createErr
}

func (a *fakeDiscordAPI) AddThreadMember(_ context.Context, threadID, userID string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.added = append(a.added, [2]string{threadID, userID})
	return a.addErr
}

func (a *fakeDiscordAPI) ArchiveThread(_ context.Context, threadID string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.archived = append(a.archived, threadID)
	return nil
}

func (a *fakeDiscordAPI) GetMessage(_ context.Context, channelID, messageID string) (*discordgo.Message, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.fetchErr != nil {
		return nil, a.fetchErr
	}
	return a.fetched[channelID+":"+messageID], nil
}

func (a *fakeDiscordAPI) SendMessage(_ context.Context, channelID string, message *discordgo.MessageSend) (*discordgo.Message, error) {
	a.mu.Lock()
	a.sent = append(a.sent, sentDiscordMessage{channelID: channelID, message: message})
	notify := a.sentNotify
	a.mu.Unlock()
	if notify != nil {
		select {
		case notify <- struct{}{}:
		default:
		}
	}
	return &discordgo.Message{ID: "sent"}, nil
}

func (a *fakeDiscordAPI) TriggerTyping(_ context.Context, channelID string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.typing = append(a.typing, channelID)
	return nil
}

func (a *fakeDiscordAPI) snapshotSent() []sentDiscordMessage {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]sentDiscordMessage(nil), a.sent...)
}

type fakeConversationStore struct {
	mu sync.Mutex

	messages      map[string]store.DiscordMessage
	conversations map[string]store.DiscordConversation
	runs          map[string]store.DiscordRun
	prunedBefore  *time.Time
	lifecycle     *lifecycleLog
}

func newFakeConversationStore() *fakeConversationStore {
	return &fakeConversationStore{
		messages:      make(map[string]store.DiscordMessage),
		conversations: make(map[string]store.DiscordConversation),
		runs:          make(map[string]store.DiscordRun),
	}
}

func (s *fakeConversationStore) ClaimDiscordMessage(_ context.Context, message store.DiscordMessage) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.messages[message.MessageID]; ok {
		return false, nil
	}
	s.messages[message.MessageID] = message
	return true, nil
}

func (s *fakeConversationStore) CompleteDiscordMessage(_ context.Context, messageID, status, safeErr string, completedAt time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	message, ok := s.messages[messageID]
	if !ok {
		return errors.New("message does not exist")
	}
	message.Status = status
	message.Error = safeErr
	message.CompletedAt = &completedAt
	s.messages[messageID] = message
	return nil
}

func (s *fakeConversationStore) UpsertDiscordConversation(_ context.Context, conversation store.DiscordConversation) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conversations[conversation.ThreadID] = conversation
	return nil
}

func (s *fakeConversationStore) LoadDiscordConversation(_ context.Context, threadID string) (store.DiscordConversation, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	conversation, ok := s.conversations[threadID]
	return conversation, ok, nil
}

func (s *fakeConversationStore) ListDiscordConversations(_ context.Context) ([]store.DiscordConversation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var conversations []store.DiscordConversation
	for _, conversation := range s.conversations {
		conversations = append(conversations, conversation)
	}
	return conversations, nil
}

func (s *fakeConversationStore) DeleteDiscordConversation(_ context.Context, threadID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.conversations[threadID]; !ok {
		return errors.New("conversation does not exist")
	}
	delete(s.conversations, threadID)
	s.lifecycle.record("delete-conversation:" + threadID)
	return nil
}

func (s *fakeConversationStore) ListRecoverableDiscordMessages(_ context.Context) ([]store.DiscordMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var messages []store.DiscordMessage
	for _, message := range s.messages {
		if message.CompletedAt == nil && message.Status == store.DiscordMessageClaimed {
			messages = append(messages, message)
		}
	}
	return messages, nil
}

// StartDiscordRun mirrors the real store: every consumed message leaves the
// retryable claimed state in the same step that records the run.
func (s *fakeConversationStore) StartDiscordRun(_ context.Context, run store.DiscordRun) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.messages[run.MessageID]; !ok {
		return errors.New("message does not exist")
	}
	for _, messageID := range append([]string{run.MessageID}, run.BatchMessageIDs...) {
		message, ok := s.messages[messageID]
		if !ok {
			return errors.New("message does not exist")
		}
		message.Status = store.DiscordMessageRunning
		s.messages[messageID] = message
	}
	s.runs[run.ID] = run
	return nil
}

func (s *fakeConversationStore) MarkInterruptedDiscordMessages(_ context.Context, safeErr string, at time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for messageID, message := range s.messages {
		if message.CompletedAt != nil || message.Status != store.DiscordMessageRunning {
			continue
		}
		completedAt := at
		message.Status = store.DiscordStatusInterrupted
		message.Error = safeErr
		message.CompletedAt = &completedAt
		s.messages[messageID] = message
	}
	return nil
}

func (s *fakeConversationStore) CompleteDiscordRun(_ context.Context, runID, status, safeErr string, completedAt time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, ok := s.runs[runID]
	if !ok {
		return errors.New("run does not exist")
	}
	run.Status = status
	run.Error = safeErr
	run.CompletedAt = &completedAt
	s.runs[runID] = run
	message := s.messages[run.MessageID]
	message.Status = status
	message.Error = safeErr
	message.CompletedAt = &completedAt
	s.messages[run.MessageID] = message
	return nil
}

func (s *fakeConversationStore) ListRecoverableDiscordRuns(_ context.Context) ([]store.DiscordRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var runs []store.DiscordRun
	for _, run := range s.runs {
		if run.CompletedAt == nil {
			runs = append(runs, run)
		}
	}
	return runs, nil
}

func (s *fakeConversationStore) PruneDiscordState(_ context.Context, before time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prunedBefore = &before
	return nil
}

func TestConversationPublicDirectRoute(t *testing.T) {
	state := newFakeConversationStore()
	api := &fakeDiscordAPI{botUserID: "bot"}
	runner := &recordingConversationRunner{respond: func(_ context.Context, request harness.Request) (string, error) {
		switch request.Source {
		case "discord_triage":
			return triageJSON("direct", "release", "en"), nil
		case "discord_direct":
			return "Public answer with @everyone and <@123>.", nil
		default:
			return "", errors.New("unexpected source")
		}
	}}
	agent := testConversationAgent(runner, state, api)
	message := testDiscordMessage("message-1", "public", "owner", "When does the new season air?")

	if err := agent.handleMessage(context.Background(), message); err != nil {
		t.Fatalf("handleMessage() error = %v", err)
	}
	requests := runner.snapshot()
	if len(requests) != 2 {
		t.Fatalf("runner requests = %d, want 2", len(requests))
	}
	if requests[0].Source != "discord_triage" || requests[1].Source != "discord_direct" {
		t.Errorf("runner sources = [%s, %s]", requests[0].Source, requests[1].Source)
	}
	if requests[1].ThreadID != "" {
		t.Errorf("direct ThreadID = %q, want sessionless empty ID", requests[1].ThreadID)
	}
	sent := api.snapshotSent()
	if len(sent) != 1 || sent[0].channelID != "public" {
		t.Fatalf("sent messages = %+v, want one public response", sent)
	}
	if sent[0].message.AllowedMentions == nil || len(sent[0].message.AllowedMentions.Parse) != 0 {
		t.Error("public response does not suppress generated mentions")
	}
	if sent[0].message.Reference == nil || sent[0].message.Reference.MessageID != message.ID {
		t.Error("direct response does not reference the triggering message")
	}
	api.mu.Lock()
	typing := append([]string(nil), api.typing...)
	api.mu.Unlock()
	if len(typing) == 0 || typing[0] != "public" {
		t.Errorf("typing indicators = %v, want public channel", typing)
	}
}

func TestNewWithConversationGatewayIntents(t *testing.T) {
	cfg := testConversationConfig()
	cfg.DiscordToken = "test-token"
	bot, err := NewWithConversation(cfg, nil, ConversationOptions{
		Context: context.Background(),
		Runner: conversationRunnerFunc(func(context.Context, harness.Request) (string, error) {
			return "", nil
		}),
		Store: newFakeConversationStore(),
	})
	if err != nil {
		t.Fatalf("NewWithConversation() error = %v", err)
	}
	defer bot.cancel()
	intents := bot.session.Identify.Intents
	for _, intent := range []discordgo.Intent{discordgo.IntentsGuilds, discordgo.IntentsGuildMessages, discordgo.IntentsMessageContent} {
		if intents&intent == 0 {
			t.Errorf("gateway intents %v do not include %v", intents, intent)
		}
	}
	if intents&discordgo.IntentsGuildMembers != 0 || intents&discordgo.IntentsGuildMessageReactions != 0 {
		t.Errorf("gateway intents %v include unrelated privileged/event intents", intents)
	}
}

func TestConversationTriageFailsClosed(t *testing.T) {
	tests := []struct {
		name      string
		mentioned bool
		response  string
		wantSent  int
	}{
		{name: "passive invalid response stays silent", response: "not json"},
		{name: "mentioned invalid response gets concise failure", mentioned: true, response: "not json", wantSent: 1},
		{name: "mentioned unsupported gets concise response", mentioned: true, response: triageJSON("ignore", "unsupported", "de"), wantSent: 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			state := newFakeConversationStore()
			api := &fakeDiscordAPI{botUserID: "bot"}
			runner := &recordingConversationRunner{respond: func(_ context.Context, _ harness.Request) (string, error) {
				return tt.response, nil
			}}
			agent := testConversationAgent(runner, state, api)
			message := testDiscordMessage("message", "public", "owner", "unrelated")
			if tt.mentioned {
				message.Mentions = []*discordgo.User{{ID: "bot"}}
			}
			if err := agent.handleMessage(context.Background(), message); err != nil {
				t.Fatalf("handleMessage() error = %v", err)
			}
			if got := len(api.snapshotSent()); got != tt.wantSent {
				t.Errorf("sent messages = %d, want %d", got, tt.wantSent)
			}
			if got := len(runner.snapshot()); got != 1 {
				t.Errorf("runner requests = %d, want triage only", got)
			}
		})
	}
}

func TestConversationIgnoresUnwatchedAndAttachmentOnlyMessages(t *testing.T) {
	state := newFakeConversationStore()
	api := &fakeDiscordAPI{botUserID: "bot"}
	runner := &recordingConversationRunner{respond: func(_ context.Context, _ harness.Request) (string, error) {
		return "", errors.New("runner should not be called")
	}}
	agent := testConversationAgent(runner, state, api)
	unwatched := testDiscordMessage("unwatched", "other-channel", "owner", "Jellyfin ist kaputt")
	attachmentOnly := testDiscordMessage("attachment", "public", "owner", "")
	attachmentOnly.Attachments = []*discordgo.MessageAttachment{{ID: "attachment-id", Filename: "private.png"}}
	for _, message := range []*discordgo.Message{unwatched, attachmentOnly} {
		if err := agent.handleMessage(context.Background(), message); err != nil {
			t.Fatalf("handleMessage(%s) error = %v", message.ID, err)
		}
	}
	if got := len(runner.snapshot()); got != 0 {
		t.Errorf("runner requests = %d, want none", got)
	}
	state.mu.Lock()
	claimed := len(state.messages)
	state.mu.Unlock()
	if claimed != 0 {
		t.Errorf("claimed messages = %d, want none", claimed)
	}
}

func TestConversationPrivateRoute(t *testing.T) {
	state := newFakeConversationStore()
	api := &fakeDiscordAPI{
		botUserID:  "bot",
		thread:     &discordgo.Channel{ID: "private-thread"},
		sentNotify: make(chan struct{}, 2),
	}
	runner := &recordingConversationRunner{respond: func(_ context.Context, request harness.Request) (string, error) {
		if request.Source == "discord_triage" {
			return triageJSON("private", "service", "de"), nil
		}
		return "Private service result", nil
	}}
	agent := testConversationAgent(runner, state, api)
	message := testDiscordMessage("987654321012345678", "public", "owner", "Ist mein geheimer Film schon auf dem Server?")

	if err := agent.handleMessage(context.Background(), message); err != nil {
		t.Fatalf("handleMessage() error = %v", err)
	}
	waitForSignal(t, api.sentNotify)
	api.mu.Lock()
	spec := api.createSpec
	added := append([][2]string(nil), api.added...)
	api.mu.Unlock()
	if spec.ParentID != "public" || spec.Invitable || spec.AutoArchiveMinutes != 1440 {
		t.Errorf("private thread spec = %+v", spec)
	}
	if strings.Contains(strings.ToLower(spec.Name), "film") || strings.Contains(strings.ToLower(spec.Name), "server") {
		t.Errorf("thread name %q contains request/media text", spec.Name)
	}
	if len(added) != 1 || added[0] != [2]string{"private-thread", "owner"} {
		t.Errorf("added members = %+v, want only owner", added)
	}
	sent := api.snapshotSent()
	if len(sent) != 1 || sent[0].channelID != "private-thread" {
		t.Fatalf("sent = %+v, sensitive result must only go to private thread", sent)
	}
	requests := runner.snapshot()
	if len(requests) != 2 || requests[1].Source != "discord_thread" || requests[1].ThreadID != "private-thread" {
		t.Fatalf("working request = %+v", requests)
	}
	if requests[1].MutationBudget != 3 {
		t.Errorf("mutation budget = %d, want 3", requests[1].MutationBudget)
	}
}

func TestConversationThreadFailureHasNoSensitiveFallback(t *testing.T) {
	state := newFakeConversationStore()
	api := &fakeDiscordAPI{botUserID: "bot", createErr: errors.New("forbidden")}
	runner := &recordingConversationRunner{respond: func(_ context.Context, _ harness.Request) (string, error) {
		return triageJSON("private", "service", "de"), nil
	}}
	agent := testConversationAgent(runner, state, api)
	secret := "Mein privater Filmstatus ist streng geheim"

	if err := agent.handleMessage(context.Background(), testDiscordMessage("message", "public", "owner", secret)); err != nil {
		t.Fatalf("handleMessage() error = %v", err)
	}
	sent := api.snapshotSent()
	if len(sent) != 1 || sent[0].channelID != "public" {
		t.Fatalf("sent = %+v, want one generic public failure", sent)
	}
	if strings.Contains(sent[0].message.Content, secret) || strings.Contains(sent[0].message.Content, "Filmstatus") {
		t.Errorf("public fallback leaked request: %q", sent[0].message.Content)
	}
	if len(runner.snapshot()) != 1 {
		t.Error("working agent ran after private thread creation failed")
	}
}

func TestConversationOwnerBypassesTriageAndDebouncesInOrder(t *testing.T) {
	state := newFakeConversationStore()
	conversation := store.DiscordConversation{
		ThreadID: "thread", OwnerID: "owner", ParentChannelID: "public", Route: "private", Category: "support", Status: store.DiscordConversationActive,
	}
	state.conversations[conversation.ThreadID] = conversation
	api := &fakeDiscordAPI{botUserID: "bot", sentNotify: make(chan struct{}, 2)}
	runner := &recordingConversationRunner{respond: func(_ context.Context, request harness.Request) (string, error) {
		if request.Source != "discord_thread" {
			return "", errors.New("triage must not run in owned thread")
		}
		return "Zusammengefasste Antwort", nil
	}}
	agent := testConversationAgent(runner, state, api)
	agent.conversations[conversation.ThreadID] = conversation

	if err := agent.handleMessage(context.Background(), testDiscordMessage("outsider", "thread", "moderator", "I can manage threads")); err != nil {
		t.Fatalf("outsider handleMessage() error = %v", err)
	}
	if err := agent.handleMessage(context.Background(), testDiscordMessage("one", "thread", "owner", "erste Nachricht")); err != nil {
		t.Fatalf("first owner message error = %v", err)
	}
	if err := agent.handleMessage(context.Background(), testDiscordMessage("two", "thread", "owner", "zweite Nachricht")); err != nil {
		t.Fatalf("second owner message error = %v", err)
	}
	waitForSignal(t, api.sentNotify)
	requests := runner.snapshot()
	if len(requests) != 1 {
		t.Fatalf("runner requests = %d, want one debounced run", len(requests))
	}
	var payload struct {
		Messages []ownerMessage `json:"messages"`
	}
	if err := json.Unmarshal([]byte(requests[0].Content), &payload); err != nil {
		t.Fatalf("decode working content: %v", err)
	}
	if len(payload.Messages) != 2 || payload.Messages[0].ID != "one" || payload.Messages[1].ID != "two" {
		t.Errorf("batched messages = %+v, want owner messages in arrival order", payload.Messages)
	}
	state.mu.Lock()
	_, outsiderClaimed := state.messages["outsider"]
	state.mu.Unlock()
	if outsiderClaimed {
		t.Error("non-owner private thread message was claimed or processed")
	}
}

func TestConversationSerializesThreadRuns(t *testing.T) {
	state := newFakeConversationStore()
	conversation := store.DiscordConversation{ThreadID: "thread", OwnerID: "owner", Route: "private", Category: "support", Status: store.DiscordConversationActive}
	state.conversations[conversation.ThreadID] = conversation
	api := &fakeDiscordAPI{botUserID: "bot", sentNotify: make(chan struct{}, 4)}
	started := make(chan string, 2)
	release := make(chan struct{})
	var mu sync.Mutex
	active := 0
	maximum := 0
	runner := &recordingConversationRunner{respond: func(_ context.Context, request harness.Request) (string, error) {
		mu.Lock()
		active++
		if active > maximum {
			maximum = active
		}
		mu.Unlock()
		started <- request.RunID
		<-release
		mu.Lock()
		active--
		mu.Unlock()
		return "ok", nil
	}}
	agent := testConversationAgent(runner, state, api)
	agent.cfg.DiscordDebounce = time.Millisecond
	agent.conversations[conversation.ThreadID] = conversation
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := agent.handleMessage(ctx, testDiscordMessage("one", "thread", "owner", "one")); err != nil {
		t.Fatal(err)
	}
	waitForSignal(t, started)
	if err := agent.handleMessage(ctx, testDiscordMessage("two", "thread", "owner", "two")); err != nil {
		t.Fatal(err)
	}
	select {
	case runID := <-started:
		t.Fatalf("second run %q started before first completed", runID)
	case <-time.After(25 * time.Millisecond):
	}
	release <- struct{}{}
	waitForSignal(t, started)
	release <- struct{}{}
	waitForSignal(t, api.sentNotify)
	waitForSignal(t, api.sentNotify)
	mu.Lock()
	gotMaximum := maximum
	mu.Unlock()
	if gotMaximum != 1 {
		t.Errorf("maximum concurrent thread runs = %d, want 1", gotMaximum)
	}
}

func TestConversationDeduplicatesMessages(t *testing.T) {
	state := newFakeConversationStore()
	api := &fakeDiscordAPI{botUserID: "bot"}
	runner := &recordingConversationRunner{respond: func(_ context.Context, request harness.Request) (string, error) {
		if request.Source == "discord_triage" {
			return triageJSON("direct", "general", "de"), nil
		}
		return "Antwort", nil
	}}
	agent := testConversationAgent(runner, state, api)
	message := testDiscordMessage("same", "public", "owner", "Welche Folge kommt heute?")
	if err := agent.handleMessage(context.Background(), message); err != nil {
		t.Fatal(err)
	}
	if err := agent.handleMessage(context.Background(), message); err != nil {
		t.Fatal(err)
	}
	if got := len(runner.snapshot()); got != 2 {
		t.Errorf("runner requests = %d, want exactly triage + direct once", got)
	}
	if got := len(api.snapshotSent()); got != 1 {
		t.Errorf("sent messages = %d, want one", got)
	}
}

func TestConversationRecoveryRestoresOwnershipAndMarksRunsInterrupted(t *testing.T) {
	state := newFakeConversationStore()
	now := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
	state.conversations["thread"] = store.DiscordConversation{ThreadID: "thread", OwnerID: "owner", Route: "private", Category: "support", Status: store.DiscordConversationActive}
	state.messages["old-message"] = store.DiscordMessage{MessageID: "old-message", Status: store.DiscordMessageRunning}
	state.runs["old-run"] = store.DiscordRun{ID: "old-run", MessageID: "old-message", Source: "discord_thread", Status: store.DiscordRunRunning}
	api := &fakeDiscordAPI{botUserID: "bot", sentNotify: make(chan struct{}, 1)}
	runner := &recordingConversationRunner{respond: func(_ context.Context, request harness.Request) (string, error) {
		if request.Source != "discord_thread" {
			return "", errors.New("unexpected triage")
		}
		return "wieder da", nil
	}}
	agent := newConversationAgent(testConversationConfig(), runner, state, api, func() time.Time { return now })
	if err := agent.recover(context.Background()); err != nil {
		t.Fatalf("recover() error = %v", err)
	}
	state.mu.Lock()
	interrupted := state.runs["old-run"]
	prunedBefore := state.prunedBefore
	state.mu.Unlock()
	if interrupted.Status != "interrupted" || interrupted.CompletedAt == nil {
		t.Errorf("interrupted run = %+v", interrupted)
	}
	if prunedBefore == nil || !prunedBefore.Equal(now.Add(-30*24*time.Hour)) {
		t.Errorf("prune cutoff = %v", prunedBefore)
	}
	if err := agent.handleMessage(context.Background(), testDiscordMessage("new", "thread", "owner", "weiter")); err != nil {
		t.Fatal(err)
	}
	waitForSignal(t, api.sentNotify)
	if requests := runner.snapshot(); len(requests) != 1 || requests[0].Source != "discord_thread" {
		t.Errorf("recovered conversation requests = %+v", requests)
	}
}

func TestConversationRecoveryRefetchesClaimedMessageWithoutPersistingContent(t *testing.T) {
	state := newFakeConversationStore()
	now := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
	state.messages["claimed"] = store.DiscordMessage{
		MessageID: "claimed", ChannelID: "public", AuthorID: "owner",
		Status: store.DiscordMessageClaimed, ReceivedAt: now.Add(-time.Minute),
	}
	source := testDiscordMessage("claimed", "public", "owner", "Nur allgemeines Gerede")
	// discordgo's ChannelMessage response does not include GuildID.
	source.GuildID = ""
	api := &fakeDiscordAPI{
		botUserID: "bot",
		fetched:   map[string]*discordgo.Message{"public:claimed": source},
	}
	runner := &recordingConversationRunner{respond: func(_ context.Context, request harness.Request) (string, error) {
		if request.Source != "discord_triage" {
			return "", errors.New("unexpected working run")
		}
		return triageJSON("ignore", "general", "de"), nil
	}}
	agent := newConversationAgent(testConversationConfig(), runner, state, api, func() time.Time { return now })
	if err := agent.recover(context.Background()); err != nil {
		t.Fatalf("recover() error = %v", err)
	}
	if requests := runner.snapshot(); len(requests) != 1 || requests[0].Source != "discord_triage" {
		t.Fatalf("recovery requests = %+v", requests)
	}
	state.mu.Lock()
	message := state.messages["claimed"]
	state.mu.Unlock()
	if message.Status != "ignored" || message.CompletedAt == nil {
		t.Fatalf("recovered message = %+v", message)
	}
}

func TestExplicitConfirmation(t *testing.T) {
	tests := []struct {
		value string
		want  bool
	}{
		{value: "ja", want: true},
		{value: "Ja, bitte!", want: true},
		{value: "yes please", want: true},
		{value: "do it", want: true},
		{value: "okay", want: true},
		{value: "Ja, aber lösche stattdessen alles"},
		{value: "I think you should do it"},
		{value: "bitte prüfe erst noch einmal"},
		{value: ""},
	}
	for _, tt := range tests {
		t.Run(tt.value, func(t *testing.T) {
			if got := explicitConfirmation(tt.value); got != tt.want {
				t.Errorf("explicitConfirmation(%q) = %v, want %v", tt.value, got, tt.want)
			}
		})
	}
}

func TestWorkingRequestBindsAuthorityAndConfirmation(t *testing.T) {
	agent := newConversationAgent(testConversationConfig(), nil, nil, nil, time.Now)
	message := ownerMessage{ID: "message", AuthorID: "owner", Author: "requester", Content: "Ja, bitte!"}
	request := agent.workingRequest("discord_thread", "thread", "private", "service", []ownerMessage{message})
	if !request.Confirmation {
		t.Error("single explicit owner confirmation was not marked as confirmation")
	}
	if !strings.Contains(request.Authority, `"actor_id":"owner"`) || !strings.Contains(request.Authority, "Ja, bitte!") {
		t.Errorf("authority = %q, want actor and exact current message", request.Authority)
	}
	if request.ThreadID != "thread" || request.ActorID != "owner" {
		t.Errorf("request context = thread %q actor %q", request.ThreadID, request.ActorID)
	}

	request = agent.workingRequest("discord_thread", "thread", "private", "service", []ownerMessage{message, {
		ID: "message-2", AuthorID: "owner", Content: "noch etwas",
	}})
	if request.Confirmation {
		t.Error("multi-message batch was incorrectly marked as confirmation")
	}
}

func testConversationAgent(runner ConversationRunner, state ConversationStore, api discordAPI) *conversationAgent {
	return newConversationAgent(testConversationConfig(), runner, state, api, time.Now)
}

func testConversationConfig() config.Config {
	return config.Config{
		DiscordWatchedChannelIDs: []string{"public"},
		DiscordTriageTimeout:     time.Second,
		DiscordRunTimeout:        time.Second,
		DiscordDebounce:          20 * time.Millisecond,
		DiscordThreadInactivity:  24 * time.Hour,
		DiscordRetention:         30 * 24 * time.Hour,
		DiscordMutationBudget:    3,
	}
}

func testDiscordMessage(id, channelID, authorID, content string) *discordgo.Message {
	return &discordgo.Message{
		ID:        id,
		ChannelID: channelID,
		GuildID:   "guild",
		Content:   content,
		Type:      discordgo.MessageTypeDefault,
		Author:    &discordgo.User{ID: authorID, Username: "requester"},
	}
}

func triageJSON(route, category, language string) string {
	relevant := route != "ignore"
	respond := route != "ignore"
	data, _ := json.Marshal(map[string]any{
		"relevant": relevant,
		"respond":  respond,
		"route":    route,
		"category": category,
		"language": language,
		"reason":   "test decision",
	})
	return string(data)
}

func waitForSignal[T any](t *testing.T, channel <-chan T) T {
	t.Helper()
	select {
	case value := <-channel:
		return value
	case <-time.After(2 * time.Second):
		var zero T
		t.Fatal("timed out waiting for asynchronous Discord work")
		return zero
	}
}
