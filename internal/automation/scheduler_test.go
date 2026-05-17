package automation

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"blitzcrank/internal/agent"
	"blitzcrank/internal/config"
	"github.com/robfig/cron/v3"
)

type fakeRunner struct {
	reply    string
	err      error
	requests *[]agent.Request
}

func (f fakeRunner) Respond(_ context.Context, req agent.Request) (string, error) {
	if f.requests != nil {
		*f.requests = append(*f.requests, req)
	}
	return f.reply, f.err
}

type fakeReporter struct {
	err      error
	messages *[]string
}

func (f fakeReporter) SendMessage(_ context.Context, message string) error {
	if f.messages != nil {
		*f.messages = append(*f.messages, message)
	}
	return f.err
}

func TestNextRunUsesConfiguredTimezone(t *testing.T) {
	scheduler := NewScheduler(config.Config{
		Timezone: "Europe/Vienna",
	}, nil, nil, nil)
	scheduler.tasks = []Task{{Name: "test", cron: mustSchedule(t, "0 9 * * *")}}

	now := time.Date(2026, 5, 16, 8, 30, 0, 0, time.FixedZone("UTC", 0))
	next := scheduler.nextRun(now)
	if next.Location().String() != "Europe/Vienna" {
		t.Fatalf("location = %s", next.Location())
	}
	if next.Hour() != 9 || next.Minute() != 0 {
		t.Fatalf("next = %s, want 09:00 local", next)
	}
}

func TestNextRunRollsToTomorrow(t *testing.T) {
	scheduler := NewScheduler(config.Config{
		Timezone: "UTC",
	}, nil, nil, nil)
	scheduler.tasks = []Task{{Name: "test", cron: mustSchedule(t, "0 9 * * *")}}

	now := time.Date(2026, 5, 16, 9, 1, 0, 0, time.UTC)
	next := scheduler.nextRun(now)
	if next.Day() != 17 || next.Hour() != 9 || next.Minute() != 0 {
		t.Fatalf("next = %s, want tomorrow at 09:00 UTC", next)
	}
}

func TestAutomationRuntimeMetadataIncludesNextRuns(t *testing.T) {
	scheduler := NewScheduler(config.Config{
		AutomationsEnabled: true,
		Timezone:           "Europe/Vienna",
	}, nil, nil, nil)
	scheduler.tasks = []Task{{
		Name:        "test",
		Description: "Test automation",
		Schedule:    "cron: 0 9 * * *",
		cron:        mustSchedule(t, "0 9 * * *"),
		Path:        "automations/test.md",
	}}

	metadata := scheduler.AutomationRuntimeMetadata(time.Date(2026, 5, 16, 8, 30, 0, 0, time.UTC))
	if !metadata.Enabled || metadata.Timezone != "Europe/Vienna" {
		t.Fatalf("metadata = %#v, want enabled Europe/Vienna", metadata)
	}
	if len(metadata.Tasks) != 1 {
		t.Fatalf("tasks = %#v, want one task", metadata.Tasks)
	}
	task := metadata.Tasks[0]
	if task.Name != "test" || task.Schedule != "cron: 0 9 * * *" || task.Description != "Test automation" {
		t.Fatalf("task metadata = %#v", task)
	}
	if task.NextRun.Location().String() != "Europe/Vienna" || task.NextRun.Hour() != 9 || task.NextRun.Minute() != 0 {
		t.Fatalf("next run = %s, want 09:00 Europe/Vienna", task.NextRun)
	}
}

func TestAutomationReportDeliveryWritesTrace(t *testing.T) {
	dir := t.TempDir()
	scheduler := NewScheduler(config.Config{
		ThreadsDirectory: dir,
		RunTimeout:       time.Minute,
		Timezone:         "UTC",
	}, fakeRunner{reply: "done"}, fakeReporter{err: errors.New("discord down")}, nil)
	scheduler.tasks = []Task{{Name: "test", cron: mustSchedule(t, "* * * * *")}}

	scheduler.runDue(context.Background(), time.Date(2026, 5, 16, 10, 0, 0, 0, time.UTC))
	scheduler.waitForRuns()

	data, err := os.ReadFile(filepath.Join(dir, "automations", "test.jsonl"))
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 2 {
		t.Fatalf("trace line count = %d, want 2\n%s", len(lines), string(data))
	}
	var delivery map[string]any
	if err := json.Unmarshal([]byte(lines[1]), &delivery); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if delivery["type"] != "automation_report_delivery" || delivery["error"] != "discord down" {
		t.Fatalf("delivery trace = %#v", delivery)
	}
}

func TestAutomationReportDeliveryUsesRunContext(t *testing.T) {
	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	scheduler := NewScheduler(config.Config{
		ThreadsDirectory: dir,
		RunTimeout:       time.Minute,
		Timezone:         "UTC",
	}, fakeRunner{reply: "done"}, contextAwareReporter{}, nil)

	scheduler.runTask(ctx, Task{Name: "test"})

	data, err := os.ReadFile(filepath.Join(dir, "automations", "test.jsonl"))
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 2 {
		t.Fatalf("trace line count = %d, want 2\n%s", len(lines), string(data))
	}
	var delivery map[string]any
	if err := json.Unmarshal([]byte(lines[1]), &delivery); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if delivery["type"] != "automation_report_delivery" || delivery["error"] != context.Canceled.Error() {
		t.Fatalf("delivery trace = %#v", delivery)
	}
}

func TestRunDueStartsTasksAsynchronously(t *testing.T) {
	dir := t.TempDir()
	runner := &blockingRunner{
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	scheduler := NewScheduler(config.Config{
		ThreadsDirectory: dir,
		RunTimeout:       time.Minute,
		Timezone:         "UTC",
	}, runner, nil, nil)
	scheduler.tasks = []Task{{Name: "test", cron: mustSchedule(t, "* * * * *")}}

	scheduler.runDue(context.Background(), time.Date(2026, 5, 16, 10, 0, 0, 0, time.UTC))
	select {
	case <-runner.started:
	case <-time.After(time.Second):
		t.Fatal("runner did not start")
	}
	select {
	case <-runner.done:
		t.Fatal("runDue waited for the task to finish")
	default:
	}
	close(runner.release)
	scheduler.waitForRuns()
}

func TestRunDueCatchesMissedScheduleWindow(t *testing.T) {
	dir := t.TempDir()
	var requests []agent.Request
	scheduler := NewScheduler(config.Config{
		ThreadsDirectory: dir,
		RunTimeout:       time.Minute,
		Timezone:         "UTC",
	}, fakeRunner{reply: "done", requests: &requests}, nil, nil)
	scheduler.tasks = []Task{{Name: "hourly", cron: mustSchedule(t, "0 * * * *")}}
	scheduler.lastDueCheck = time.Date(2026, 5, 16, 9, 59, 30, 0, time.UTC)

	scheduler.runDue(context.Background(), time.Date(2026, 5, 16, 10, 2, 0, 0, time.UTC))
	scheduler.waitForRuns()

	if len(requests) != 1 {
		t.Fatalf("requests = %d, want one missed hourly run", len(requests))
	}
}

func TestAutomationSilentOutputDoesNotFailOrReport(t *testing.T) {
	for _, tc := range []struct {
		name  string
		reply string
		err   error
	}{
		{name: "blank reply", reply: "   "},
		{name: "codex no assistant output", err: errors.New("codex responses completed without assistant output")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			var messages []string
			scheduler := NewScheduler(config.Config{
				ThreadsDirectory: dir,
				RunTimeout:       time.Minute,
				Timezone:         "UTC",
			}, fakeRunner{reply: tc.reply, err: tc.err}, fakeReporter{messages: &messages}, nil)

			scheduler.runTask(context.Background(), Task{
				Name:   "hourly-stale-import-handler",
				Prompt: "Run the hourly stale import handler.",
			})

			if len(messages) != 0 {
				t.Fatalf("reported messages = %#v, want none", messages)
			}
			data, err := os.ReadFile(filepath.Join(dir, "automations", "hourly-stale-import-handler.jsonl"))
			if err != nil {
				t.Fatalf("ReadFile() error = %v", err)
			}
			var record map[string]any
			if err := json.Unmarshal([]byte(strings.TrimSpace(string(data))), &record); err != nil {
				t.Fatalf("Unmarshal() error = %v", err)
			}
			if record["type"] != "automation_run" || record["silent"] != true || record["error"] != nil {
				t.Fatalf("silent automation trace = %#v", record)
			}
		})
	}
}

func TestRunTaskIncludesPriorAutomationHistory(t *testing.T) {
	dir := t.TempDir()
	traceDir := filepath.Join(dir, "automations")
	if err := os.MkdirAll(traceDir, 0o755); err != nil {
		t.Fatal(err)
	}
	trace := strings.Join([]string{
		`{"type":"automation_report_delivery","posted":true}`,
		`{"type":"automation_run","completed":"2026-05-16T10:00:00Z","result":"Manuell pruefen:\n- MANUAL_INTERVENTION_REQUIRED Sonarr Some Show S01E02 /downloads/show/file.mkv wrong-episode download"}`,
		`{"type":"discord_automation_report","at":"2026-05-16T10:00:01Z","message":"Validierung: Import wurde angenommen, Queue-Eintrag meldet weiterhin den Import-Blocker."}`,
	}, "\n") + "\n"
	if err := os.WriteFile(filepath.Join(traceDir, "hourly-stale-import-handler.jsonl"), []byte(trace), 0o600); err != nil {
		t.Fatal(err)
	}

	var requests []agent.Request
	scheduler := NewScheduler(config.Config{
		ThreadsDirectory: dir,
		RunTimeout:       time.Minute,
		Timezone:         "UTC",
	}, fakeRunner{reply: "done", requests: &requests}, nil, nil)

	scheduler.runTask(context.Background(), Task{
		Name:   "hourly-stale-import-handler",
		Prompt: "Run the hourly stale import handler.",
	})

	if len(requests) != 1 {
		t.Fatalf("requests len = %d, want 1", len(requests))
	}
	content := requests[0].Content
	if !strings.Contains(content, "Prior automation history for hourly-stale-import-handler") {
		t.Fatalf("request content missing history header:\n%s", content)
	}
	if !strings.Contains(content, filepath.Join(dir, "automations", "hourly-stale-import-handler.jsonl")) {
		t.Fatalf("request content missing local thread trace path:\n%s", content)
	}
	if !strings.Contains(content, "Persistent manual-intervention ledger from all local thread records:") {
		t.Fatalf("request content missing manual ledger:\n%s", content)
	}
	if !strings.Contains(content, "MANUAL_INTERVENTION_REQUIRED Sonarr Some Show S01E02") {
		t.Fatalf("request content missing prior manual marker:\n%s", content)
	}
	if !strings.Contains(content, "Discord automation thread report:") || !strings.Contains(content, "Queue-Eintrag meldet weiterhin den Import-Blocker") {
		t.Fatalf("request content missing Discord report transcript:\n%s", content)
	}
	if !strings.Contains(content, "Current automation prompt:\nRun the hourly stale import handler.") {
		t.Fatalf("request content missing current prompt:\n%s", content)
	}
}

func TestRunTaskKeepsOldManualMarkersAfterRecentHistoryLimit(t *testing.T) {
	dir := t.TempDir()
	traceDir := filepath.Join(dir, "automations")
	if err := os.MkdirAll(traceDir, 0o755); err != nil {
		t.Fatal(err)
	}

	var lines []string
	lines = append(lines, `{"type":"automation_run","completed":"2026-05-16T00:00:00Z","result":"Manuell prüfen:\n- MANUAL_INTERVENTION_REQUIRED Radarr Old Movie 2024 download_id=old-1 folder=/downloads/old candidate=Old Movie exact blocker wrong target"}`)
	for i := 1; i <= automationHistoryLimit+2; i++ {
		lines = append(lines, `{"type":"automation_run","completed":"2026-05-16T01:00:00Z","result":"Importiert:\n- Radarr New Movie `+string(rune('A'+i))+`"}`)
	}
	if err := os.WriteFile(filepath.Join(traceDir, "hourly-stale-import-handler.jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	var requests []agent.Request
	scheduler := NewScheduler(config.Config{
		ThreadsDirectory: dir,
		RunTimeout:       time.Minute,
		Timezone:         "UTC",
	}, fakeRunner{reply: "done", requests: &requests}, nil, nil)

	scheduler.runTask(context.Background(), Task{
		Name:   "hourly-stale-import-handler",
		Prompt: "Run the hourly stale import handler.",
	})

	if len(requests) != 1 {
		t.Fatalf("requests len = %d, want 1", len(requests))
	}
	content := requests[0].Content
	if !strings.Contains(content, "MANUAL_INTERVENTION_REQUIRED Radarr Old Movie 2024") {
		t.Fatalf("request content lost old manual marker after compaction:\n%s", content)
	}
	if strings.Contains(content, "2026-05-16T00:00:00Z\nManuell prüfen:") {
		t.Fatalf("old full record should not be in recent history window:\n%s", content)
	}
}

func TestLoadTasksFromMarkdown(t *testing.T) {
	root := t.TempDir()
	writeTask(t, root, "daily.md", "daily-health-check", "Check things")

	tasks, err := LoadTasks(root)
	if err != nil {
		t.Fatalf("LoadTasks() error = %v", err)
	}
	if len(tasks) != 1 {
		t.Fatalf("tasks len = %d, want 1", len(tasks))
	}
	if tasks[0].Name != "daily-health-check" || tasks[0].Prompt != "Check things" {
		t.Fatalf("task = %#v", tasks[0])
	}
}

func TestLoadTasksLoadsAllMarkdownTasks(t *testing.T) {
	root := t.TempDir()
	writeTask(t, root, "daily.md", "daily-health-check", "Check things")
	writeTask(t, root, "other.md", "other", "Other")

	tasks, err := LoadTasks(root)
	if err != nil {
		t.Fatalf("LoadTasks() error = %v", err)
	}
	if len(tasks) != 2 || tasks[0].Name != "daily-health-check" || tasks[1].Name != "other" {
		t.Fatalf("tasks = %#v", tasks)
	}
}

func TestLoadTaskDirsIncludesEmbeddedBaseline(t *testing.T) {
	tasks, err := LoadTaskDirs("automations", nil)
	if err != nil {
		t.Fatalf("LoadTaskDirs() error = %v", err)
	}
	if len(tasks) != 1 || tasks[0].Name != "hourly-stale-import-handler" {
		t.Fatalf("tasks = %#v, want embedded hourly-stale-import-handler", tasks)
	}
	if !strings.Contains(tasks[0].Prompt, "hourly stale import handler") {
		t.Fatalf("embedded task prompt = %q", tasks[0].Prompt)
	}
}

func TestLoadTaskDirsAddsExtraAutomations(t *testing.T) {
	root := t.TempDir()
	writeTask(t, root, "extra.md", "extra-health-check", "Extra")

	tasks, err := LoadTaskDirs("automations", []string{root})
	if err != nil {
		t.Fatalf("LoadTaskDirs() error = %v", err)
	}
	if !taskSliceContains(tasks, "hourly-stale-import-handler") || !taskSliceContains(tasks, "extra-health-check") {
		t.Fatalf("tasks = %#v, want embedded and extra automations", tasks)
	}
}

func TestLoadTaskDirsRejectsDuplicateNames(t *testing.T) {
	root := t.TempDir()
	writeTask(t, root, "duplicate.md", "hourly-stale-import-handler", "Duplicate")

	_, err := LoadTaskDirs("automations", []string{root})
	if err == nil || !strings.Contains(err.Error(), "duplicate automation") {
		t.Fatalf("LoadTaskDirs() error = %v, want duplicate automation error", err)
	}
}

func TestLoadTasksParsesCronSchedule(t *testing.T) {
	root := t.TempDir()
	content := "---\nname: frequent\ndescription: Frequent\nschedule: \"cron: */15 * * * *\"\n---\n\nRun often"
	if err := os.WriteFile(filepath.Join(root, "frequent.md"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	tasks, err := LoadTasks(root)
	if err != nil {
		t.Fatalf("LoadTasks() error = %v", err)
	}
	next := tasks[0].cron.Next(time.Date(2026, 5, 16, 10, 1, 0, 0, time.UTC))
	if next.Minute() != 15 {
		t.Fatalf("next = %s, want minute 15", next)
	}
}

func taskSliceContains(values []Task, want string) bool {
	for _, value := range values {
		if value.Name == want {
			return true
		}
	}
	return false
}

func TestLoadTasksRejectsInvalidCronSchedule(t *testing.T) {
	root := t.TempDir()
	content := "---\nname: bad\ndescription: Bad\nschedule: \"cron: nope\"\n---\n\nBad"
	if err := os.WriteFile(filepath.Join(root, "bad.md"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadTasks(root); err == nil {
		t.Fatal("LoadTasks() error = nil, want invalid cron error")
	}
}

func TestLoadTasksRejectsDailyShortcut(t *testing.T) {
	root := t.TempDir()
	content := "---\nname: bad\ndescription: Bad\nschedule: daily\n---\n\nBad"
	if err := os.WriteFile(filepath.Join(root, "bad.md"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadTasks(root); err == nil {
		t.Fatal("LoadTasks() error = nil, want daily shortcut rejection")
	}
}

func writeTask(t *testing.T, root, file, name, body string) {
	t.Helper()
	content := "---\nname: " + name + "\ndescription: Test task\nschedule: \"cron: 0 9 * * *\"\n---\n\n" + body
	if err := os.WriteFile(filepath.Join(root, file), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func mustSchedule(t *testing.T, spec string) cron.Schedule {
	t.Helper()
	schedule, err := parseSchedule(spec)
	if err != nil {
		t.Fatal(err)
	}
	return schedule
}

type blockingRunner struct {
	once    sync.Once
	started chan struct{}
	release chan struct{}
	done    chan struct{}
}

type contextAwareReporter struct{}

func (contextAwareReporter) SendMessage(ctx context.Context, message string) error {
	return ctx.Err()
}

func (r *blockingRunner) Respond(ctx context.Context, req agent.Request) (string, error) {
	r.once.Do(func() {
		r.done = make(chan struct{})
		close(r.started)
	})
	defer close(r.done)
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case <-r.release:
		return "done", nil
	}
}
