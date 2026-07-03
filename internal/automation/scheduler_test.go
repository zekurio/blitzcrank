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
	// progressEvents, if non-empty, are emitted via req.Progress (in order)
	// before the fake returns its reply/err.
	progressEvents []harness.ProgressEvent
}

func (f *fakeRunner) Respond(ctx context.Context, req harness.Request) (string, error) {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
	if f.started != nil {
		close(f.started)
	}
	if req.Progress != nil {
		for _, event := range f.progressEvents {
			req.Progress(event)
		}
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

// fakeToolFailureStore is a minimal in-memory ToolFailureStore for tests.
type fakeToolFailureStore struct {
	mu       sync.Mutex
	failures map[string][]ToolFailure
}

func newFakeToolFailureStore() *fakeToolFailureStore {
	return &fakeToolFailureStore{failures: map[string][]ToolFailure{}}
}

func (f *fakeToolFailureStore) ResetToolFailures(threadID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.failures, threadID)
}

func (f *fakeToolFailureStore) DrainToolFailures(threadID string) []ToolFailure {
	f.mu.Lock()
	defer f.mu.Unlock()
	failures := append([]ToolFailure(nil), f.failures[threadID]...)
	delete(f.failures, threadID)
	return failures
}

func (f *fakeToolFailureStore) RecordToolFailure(threadID string, failure ToolFailure) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failures[threadID] = append(f.failures[threadID], failure)
}

// fakeReporter records the arguments passed to AutomationCompleted so tests
// can assert on the drained tool failures the scheduler hands to reporters.
type fakeReporter struct {
	mu               sync.Mutex
	completedTask    Task
	completedResp    string
	completedErr     error
	completedFailure []ToolFailure
}

func (f *fakeReporter) AutomationStarted(context.Context, Task) (ReportHandle, error) {
	return ReportHandle{}, nil
}

func (f *fakeReporter) AutomationCompleted(_ context.Context, _ ReportHandle, task Task, response string, err error, failures []ToolFailure) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.completedTask = task
	f.completedResp = response
	f.completedErr = err
	f.completedFailure = failures
	return nil
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

func TestRunAutomationRecordsToolFailures(t *testing.T) {
	runner := &fakeRunner{
		reply: "ok",
		progressEvents: []harness.ProgressEvent{
			{Phase: "tool_done", ToolName: "sonarr_request", Error: "HTTP 500"},
		},
	}
	s := newTestScheduler(t, runner, time.Second)

	store := newFakeToolFailureStore()
	s.SetToolFailureStore(store)

	reporter := &fakeReporter{}
	s.SetReporter(reporter)

	if err := s.RunAutomation(context.Background(), "test-automation"); err != nil {
		t.Fatalf("RunAutomation returned error: %v", err)
	}

	reporter.mu.Lock()
	failures := reporter.completedFailure
	reporter.mu.Unlock()

	if len(failures) != 1 {
		t.Fatalf("expected exactly 1 recorded failure, got %d: %+v", len(failures), failures)
	}
	want := ToolFailure{Tool: "sonarr_request", Error: "HTTP 500"}
	if failures[0] != want {
		t.Fatalf("expected failure %+v, got %+v", want, failures[0])
	}
}
