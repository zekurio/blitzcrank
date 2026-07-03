package automation

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"blitzcrank/internal/config"
	"blitzcrank/internal/harness"
)

func writeTask(t *testing.T, dir, name string) {
	t.Helper()
	body := "---\nname: " + name + "\nschedule: \"@hourly\"\n---\n\nBody"
	if err := os.WriteFile(filepath.Join(dir, name+".md"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

type fakeRunner struct {
	mu      sync.Mutex
	calls   int
	reply   string
	err     error
	delay   time.Duration
	started chan struct{}
	release chan struct{}
	// blockOnCtx, when true, ignores delay/release and blocks until ctx is
	// done, then returns ctx.Err().
	blockOnCtx bool
}

func (f *fakeRunner) Respond(ctx context.Context, _ harness.Request) (string, error) {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
	if f.started != nil {
		close(f.started)
	}
	if f.blockOnCtx {
		<-ctx.Done()
		return "", ctx.Err()
	}
	if f.delay > 0 {
		timer := time.NewTimer(f.delay)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	if f.release != nil {
		select {
		case <-f.release:
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	return f.reply, f.err
}

func newTestScheduler(t *testing.T, runner Runner, timeout time.Duration) *Scheduler {
	t.Helper()
	dir := t.TempDir()
	writeTask(t, dir, "test-automation")
	cfg := config.Config{
		AutomationsDirectory: dir,
		AutomationsEnabled:   true,
		RunTimeout:           timeout,
	}
	return NewScheduler(cfg, runner, nil)
}

func TestRunAutomationRejectsOverlap(t *testing.T) {
	runner := &fakeRunner{
		reply:   "ok",
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	s := newTestScheduler(t, runner, time.Minute)

	firstErr := make(chan error, 1)
	go func() {
		firstErr <- s.RunAutomation(context.Background(), "test-automation")
	}()

	select {
	case <-runner.started:
	case <-time.After(2 * time.Second):
		t.Fatal("first run never started")
	}

	if err := s.RunAutomation(context.Background(), "test-automation"); err == nil {
		t.Fatal("expected overlap error, got nil")
	} else if !strings.Contains(err.Error(), "already running") {
		t.Fatalf("expected error to contain %q, got %q", "already running", err.Error())
	}

	close(runner.release)

	select {
	case err := <-firstErr:
		if err != nil {
			t.Fatalf("expected first run to succeed, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("first run never completed")
	}
}

func TestRunAutomationTimesOut(t *testing.T) {
	runner := &fakeRunner{blockOnCtx: true}
	s := newTestScheduler(t, runner, 50*time.Millisecond)

	done := make(chan error, 1)
	go func() {
		done <- s.RunAutomation(context.Background(), "test-automation")
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected timeout error, got nil")
		}
		if !strings.Contains(err.Error(), "deadline exceeded") && !strings.Contains(err.Error(), "context") {
			t.Fatalf("expected a context deadline error, got %q", err.Error())
		}
	case <-time.After(time.Second):
		t.Fatal("RunAutomation did not return within timeout window")
	}
}

func TestAutomationNamesConcurrentWithReload(t *testing.T) {
	runner := &fakeRunner{reply: "ok"}
	s := newTestScheduler(t, runner, time.Second)

	stop := make(chan struct{})
	namesDone := make(chan struct{})
	go func() {
		defer close(namesDone)
		for {
			select {
			case <-stop:
				return
			default:
				_ = s.AutomationNames()
			}
		}
	}()

	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		for i := 0; i < 20; i++ {
			_ = s.RunAutomation(context.Background(), "test-automation")
		}
	}()

	select {
	case <-runDone:
	case <-time.After(5 * time.Second):
		t.Fatal("RunAutomation loop did not complete in time")
	}
	close(stop)

	select {
	case <-namesDone:
	case <-time.After(5 * time.Second):
		t.Fatal("AutomationNames loop did not exit after stop signal")
	}
}
