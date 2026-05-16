package automation

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"blitzcrank/internal/config"
	"github.com/robfig/cron/v3"
)

func TestNextRunUsesConfiguredTimezone(t *testing.T) {
	scheduler := NewScheduler(config.Config{
		AutomationsDir: t.TempDir(),
		Timezone:       "Europe/Vienna",
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
		AutomationsDir: t.TempDir(),
		Timezone:       "UTC",
	}, nil, nil, nil)
	scheduler.tasks = []Task{{Name: "test", cron: mustSchedule(t, "0 9 * * *")}}

	now := time.Date(2026, 5, 16, 9, 1, 0, 0, time.UTC)
	next := scheduler.nextRun(now)
	if next.Day() != 17 || next.Hour() != 9 || next.Minute() != 0 {
		t.Fatalf("next = %s, want tomorrow at 09:00 UTC", next)
	}
}

func TestLoadTasksFromMarkdown(t *testing.T) {
	root := t.TempDir()
	writeTask(t, root, "daily.md", "daily-health-check", "Check things")

	tasks, err := LoadTasks(root, nil)
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

func TestLoadTasksFiltersByName(t *testing.T) {
	root := t.TempDir()
	writeTask(t, root, "daily.md", "daily-health-check", "Check things")
	writeTask(t, root, "other.md", "other", "Other")

	tasks, err := LoadTasks(root, []string{"other"})
	if err != nil {
		t.Fatalf("LoadTasks() error = %v", err)
	}
	if len(tasks) != 1 || tasks[0].Name != "other" {
		t.Fatalf("tasks = %#v", tasks)
	}
}

func TestLoadTasksParsesCronSchedule(t *testing.T) {
	root := t.TempDir()
	content := "---\nname: frequent\ndescription: Frequent\nschedule: \"cron: */15 * * * *\"\n---\n\nRun often"
	if err := os.WriteFile(filepath.Join(root, "frequent.md"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	tasks, err := LoadTasks(root, nil)
	if err != nil {
		t.Fatalf("LoadTasks() error = %v", err)
	}
	next := tasks[0].cron.Next(time.Date(2026, 5, 16, 10, 1, 0, 0, time.UTC))
	if next.Minute() != 15 {
		t.Fatalf("next = %s, want minute 15", next)
	}
}

func TestLoadTasksRejectsInvalidCronSchedule(t *testing.T) {
	root := t.TempDir()
	content := "---\nname: bad\ndescription: Bad\nschedule: \"cron: nope\"\n---\n\nBad"
	if err := os.WriteFile(filepath.Join(root, "bad.md"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadTasks(root, nil); err == nil {
		t.Fatal("LoadTasks() error = nil, want invalid cron error")
	}
}

func TestLoadTasksRejectsDailyShortcut(t *testing.T) {
	root := t.TempDir()
	content := "---\nname: bad\ndescription: Bad\nschedule: daily\n---\n\nBad"
	if err := os.WriteFile(filepath.Join(root, "bad.md"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadTasks(root, nil); err == nil {
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
