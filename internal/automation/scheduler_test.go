package automation

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"blitzcrank/internal/agent"
	"blitzcrank/internal/config"
	"github.com/robfig/cron/v3"
)

type fakeRunner struct {
	reply string
	err   error
}

func (f fakeRunner) Respond(context.Context, agent.Request) (string, error) {
	return f.reply, f.err
}

type fakeReporter struct {
	err error
}

func (f fakeReporter) SendMessage(context.Context, string) error {
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
		CronEnabled: true,
		Timezone:    "Europe/Vienna",
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
	tasks, err := LoadTaskDirs(nil)
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

	tasks, err := LoadTaskDirs([]string{root})
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

	_, err := LoadTaskDirs([]string{root})
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
