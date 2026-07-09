package discord

import (
	"context"
	"sync"
	"testing"
	"time"

	"blitzcrank/internal/harness"
	"blitzcrank/internal/store"

	"github.com/bwmarrin/discordgo"
)

func TestIngressRemainsClosedUntilStartedAfterRecovery(t *testing.T) {
	agent := testConversationAgent(silentRunner(), newFakeConversationStore(), &fakeDiscordAPI{botUserID: "bot"})
	message := testDiscordMessage("early", "public", "owner", "early")

	if accepted, _ := agent.submit(message); accepted {
		t.Fatal("message was accepted before recovery enabled ingress")
	}

	ctx, cancel := context.WithCancel(context.Background())
	agent.start(ctx, 1, 1)
	if accepted, _ := agent.submit(message); !accepted {
		t.Fatal("message was not accepted after ingress started")
	}
	cancel()
	agent.stop()
	agent.wait()
}

func TestIngressBuffersBoundedTrafficUntilRecoveryCompletes(t *testing.T) {
	state := newFakeConversationStore()
	runner := &recordingConversationRunner{respond: func(context.Context, harness.Request) (string, error) {
		return triageJSON("ignore", "general", "de"), nil
	}}
	agent := testConversationAgent(runner, state, &fakeDiscordAPI{botUserID: "bot"})
	agent.prepareIngress(1)
	message := testDiscordMessage("during-recovery", "public", "owner", "Hallo")

	if !agent.acceptsIngressChannel(message.ChannelID) {
		t.Fatal("eligible message was rejected while ownership recovery was pending")
	}
	if accepted, _ := agent.submit(message); !accepted {
		t.Fatal("eligible message was not buffered during ownership recovery")
	}
	if got := len(runner.snapshot()); got != 0 {
		t.Fatalf("runner requests before recovery completed = %d, want 0", got)
	}

	ctx, cancel := context.WithCancel(context.Background())
	agent.start(ctx, 1, 1)
	waitForRequestCount(t, runner, 1)
	cancel()
	agent.stop()
	agent.wait()
}

func TestIngressPrioritizesMentionsOverPassiveMessages(t *testing.T) {
	state := newFakeConversationStore()
	api := &fakeDiscordAPI{botUserID: "bot"}
	started := make(chan struct{})
	release := make(chan struct{})
	runner := &recordingConversationRunner{respond: func(_ context.Context, request harness.Request) (string, error) {
		if request.RunID == "discord-triage-first" {
			close(started)
			<-release
		}
		return triageJSON("ignore", "other", "en"), nil
	}}
	agent := testConversationAgent(runner, state, api)
	ctx, cancel := context.WithCancel(context.Background())
	agent.start(ctx, 1, 3)
	t.Cleanup(func() {
		cancel()
		agent.stop()
		agent.wait()
	})

	first := testDiscordMessage("first", "public", "owner", "first passive")
	passive := testDiscordMessage("passive", "public", "owner", "second passive")
	mention := mentionedTestMessage("mention", "public", "owner", "bot")
	if accepted, _ := agent.submit(first); !accepted {
		t.Fatal("first message was not accepted")
	}
	waitForSignal(t, started)
	if accepted, _ := agent.submit(passive); !accepted {
		t.Fatal("passive message was not accepted")
	}
	if accepted, priority := agent.submit(mention); !accepted || priority != ingressHighPriority {
		t.Fatalf("mention submit = (%v, %v), want accepted high priority", accepted, priority)
	}
	close(release)
	waitForRequestCount(t, runner, 3)

	requests := runner.snapshot()
	got := []string{requests[0].RunID, requests[1].RunID, requests[2].RunID}
	want := []string{"discord-triage-first", "discord-triage-mention", "discord-triage-passive"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("request order = %v, want %v", got, want)
		}
	}
}

func TestIngressCapacityEvictsPassiveForDirectedRequests(t *testing.T) {
	state := newFakeConversationStore()
	api := &fakeDiscordAPI{botUserID: "bot"}
	started := make(chan struct{})
	release := make(chan struct{})
	runner := &recordingConversationRunner{respond: func(_ context.Context, request harness.Request) (string, error) {
		if request.RunID == "discord-triage-first" {
			close(started)
			<-release
		}
		return triageJSON("ignore", "other", "en"), nil
	}}
	agent := testConversationAgent(runner, state, api)
	ctx, cancel := context.WithCancel(context.Background())
	agent.start(ctx, 1, 2)
	t.Cleanup(func() {
		cancel()
		agent.stop()
		agent.wait()
	})

	agent.submit(testDiscordMessage("first", "public", "owner", "first"))
	waitForSignal(t, started)
	if accepted, _ := agent.submit(testDiscordMessage("passive-1", "public", "owner", "one")); !accepted {
		t.Fatal("first queued passive message was rejected")
	}
	if accepted, _ := agent.submit(testDiscordMessage("passive-2", "public", "owner", "two")); !accepted {
		t.Fatal("second queued passive message was rejected")
	}
	if accepted, priority := agent.submit(testDiscordMessage("passive-full", "public", "owner", "full")); accepted || priority != ingressPassivePriority {
		t.Fatalf("passive overload submit = (%v, %v), want rejected passive", accepted, priority)
	}
	if accepted, _ := agent.submit(mentionedTestMessage("mention-1", "public", "owner", "bot")); !accepted {
		t.Fatal("first mention did not displace passive work")
	}
	if accepted, _ := agent.submit(mentionedTestMessage("mention-2", "public", "owner", "bot")); !accepted {
		t.Fatal("second mention did not displace passive work")
	}
	if accepted, priority := agent.submit(mentionedTestMessage("mention-full", "public", "owner", "bot")); accepted || priority != ingressHighPriority {
		t.Fatalf("directed overload submit = (%v, %v), want rejected high", accepted, priority)
	}
	close(release)
	waitForRequestCount(t, runner, 3)

	requests := runner.snapshot()
	got := []string{requests[0].RunID, requests[1].RunID, requests[2].RunID}
	want := []string{"discord-triage-first", "discord-triage-mention-1", "discord-triage-mention-2"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("request order = %v, want %v", got, want)
		}
	}
}

func TestIngressPrioritizesPrivateThreadOwner(t *testing.T) {
	agent := testConversationAgent(nil, nil, &fakeDiscordAPI{botUserID: "bot"})
	agent.conversations["thread"] = testActiveConversation("thread", "owner")

	if got := agent.ingressPriority(testDiscordMessage("owner-message", "thread", "owner", "hello")); got != ingressHighPriority {
		t.Errorf("owner thread priority = %v, want high", got)
	}
	if got := agent.ingressPriority(testDiscordMessage("observer-message", "thread", "observer", "hello")); got != ingressPassivePriority {
		t.Errorf("observer thread priority = %v, want passive", got)
	}
}

func TestAgentShutdownCancelsRunAndWaitsForBackgroundTasks(t *testing.T) {
	state := newFakeConversationStore()
	api := &fakeDiscordAPI{botUserID: "bot"}
	runStarted := make(chan struct{})
	runCanceled := make(chan struct{})
	var once sync.Once
	runner := &recordingConversationRunner{respond: func(ctx context.Context, request harness.Request) (string, error) {
		if request.Source == "discord_triage" {
			return triageJSON("direct", "release", "en"), nil
		}
		once.Do(func() { close(runStarted) })
		<-ctx.Done()
		close(runCanceled)
		return "", ctx.Err()
	}}
	agent := testConversationAgent(runner, state, api)
	ctx, cancel := context.WithCancel(context.Background())
	agent.start(ctx, 1, 2)
	if accepted, _ := agent.submit(testDiscordMessage("message", "public", "owner", "When?")); !accepted {
		t.Fatal("message was not accepted")
	}
	waitForSignal(t, runStarted)

	agent.stop()
	cancel()
	done := make(chan struct{})
	go func() {
		agent.wait()
		close(done)
	}()
	waitForSignal(t, runCanceled)
	waitForSignal(t, done)
	if accepted, _ := agent.submit(testDiscordMessage("late", "public", "owner", "late")); accepted {
		t.Fatal("message was accepted after shutdown started")
	}
}

func TestIngressStopsAcceptingWhenRootContextIsCanceled(t *testing.T) {
	agent := testConversationAgent(nil, nil, &fakeDiscordAPI{botUserID: "bot"})
	ctx, cancel := context.WithCancel(context.Background())
	agent.start(ctx, 1, 1)
	cancel()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		agent.ingressMu.Lock()
		accepting := agent.ingressAccepting
		agent.ingressMu.Unlock()
		if !accepting {
			if accepted, _ := agent.submit(testDiscordMessage("late", "public", "owner", "late")); accepted {
				t.Fatal("message was accepted after root cancellation closed ingress")
			}
			agent.stop()
			agent.wait()
			return
		}
		time.Sleep(time.Millisecond)
	}
	agent.stop()
	agent.wait()
	t.Fatal("ingress continued accepting after root context cancellation")
}

func mentionedTestMessage(id, channelID, authorID, botID string) *discordgo.Message {
	message := testDiscordMessage(id, channelID, authorID, "<@"+botID+"> help")
	message.Mentions = []*discordgo.User{{ID: botID}}
	return message
}

func testActiveConversation(threadID, ownerID string) store.DiscordConversation {
	return store.DiscordConversation{
		ThreadID: threadID,
		OwnerID:  ownerID,
		Status:   store.DiscordConversationActive,
	}
}

func waitForRequestCount(t *testing.T, runner *recordingConversationRunner, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if len(runner.snapshot()) >= want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("runner request count = %d, want at least %d", len(runner.snapshot()), want)
}
