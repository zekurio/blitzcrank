package automation

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"blitzcrank/internal/agent"
	"blitzcrank/internal/config"
	"blitzcrank/internal/store"
	"github.com/robfig/cron/v3"
)

type Reporter interface {
	SendMessage(context.Context, string) error
}

type Runner interface {
	Respond(context.Context, agent.Request) (string, error)
}

type Scheduler struct {
	cfg      config.Config
	runner   Runner
	reporter Reporter
	store    *store.Store
	tasks    []Task
}

type Task struct {
	Name        string
	Description string
	Schedule    string
	cron        cron.Schedule
	Prompt      string
	Path        string
}

func NewScheduler(cfg config.Config, runner Runner, reporter Reporter, state *store.Store) *Scheduler {
	tasks, err := LoadTasks(cfg.AutomationsDir, cfg.AutomationTasks)
	if err != nil {
		log.Printf("load automations: %v", err)
	}
	return &Scheduler{
		cfg:      cfg,
		runner:   runner,
		reporter: reporter,
		store:    state,
		tasks:    tasks,
	}
}

func (s *Scheduler) Start(ctx context.Context) {
	if !s.cfg.CronEnabled {
		log.Printf("automation scheduler disabled")
		return
	}
	if len(s.tasks) == 0 {
		log.Printf("automation scheduler enabled with no tasks")
		return
	}

	go s.loop(ctx)
	log.Printf("automation scheduler enabled: tasks=%s timezone=%s", taskNames(s.tasks), s.cfg.Timezone)
}

func (s *Scheduler) loop(ctx context.Context) {
	for {
		next := s.nextRun(time.Now())
		timer := time.NewTimer(time.Until(next))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
			s.runDue(ctx, time.Now())
		}
	}
}

func (s *Scheduler) runDue(ctx context.Context, now time.Time) {
	for _, task := range s.dueTasks(now) {
		startedAt := time.Now().UTC()
		runCtx, cancel := context.WithTimeout(ctx, s.cfg.RunTimeout)
		result, err := s.runner.Respond(runCtx, agent.Request{
			Source:  "automation_cron",
			Author:  "Blitzcrank Scheduler",
			Content: task.Prompt,
		})
		cancel()
		completedAt := time.Now().UTC()
		if err != nil {
			log.Printf("automation task %s failed: %v", task.Name, err)
			s.recordAutomationRun(task.Name, startedAt, completedAt, "", err.Error())
			s.appendTrace("automations/"+task.Name+".jsonl", map[string]any{
				"type":       "automation_run",
				"automation": task.Name,
				"started_at": startedAt.Format(time.RFC3339Nano),
				"completed":  completedAt.Format(time.RFC3339Nano),
				"error":      err.Error(),
			})
			continue
		}
		s.recordAutomationRun(task.Name, startedAt, completedAt, result, "")
		s.appendTrace("automations/"+task.Name+".jsonl", map[string]any{
			"type":       "automation_run",
			"automation": task.Name,
			"started_at": startedAt.Format(time.RFC3339Nano),
			"completed":  completedAt.Format(time.RFC3339Nano),
			"result":     result,
		})
		log.Printf("automation task %s completed: %s", task.Name, strings.ReplaceAll(result, "\n", " "))
		if s.reporter != nil {
			reportCtx, reportCancel := context.WithTimeout(context.Background(), 30*time.Second)
			if err := s.reporter.SendMessage(reportCtx, "[automation: "+task.Name+"]\n\n"+result); err != nil {
				log.Printf("automation task %s report failed: %v", task.Name, err)
			}
			reportCancel()
		}
	}
}

func (s *Scheduler) recordAutomationRun(name string, startedAt, completedAt time.Time, result, errText string) {
	if s.store == nil {
		return
	}
	if err := s.store.InsertAutomationRun(context.Background(), store.AutomationRun{
		AutomationName: name,
		StartedAt:      startedAt,
		CompletedAt:    &completedAt,
		Result:         result,
		Error:          errText,
	}); err != nil {
		log.Printf("insert automation run %s: %v", name, err)
	}
}

func (s *Scheduler) appendTrace(relPath string, value any) {
	if err := store.AppendJSONL(filepath.Join(s.cfg.ThreadsDirectory, relPath), value); err != nil {
		log.Printf("append automation trace %s: %v", relPath, err)
	}
}

func (s *Scheduler) nextRun(now time.Time) time.Time {
	location, err := time.LoadLocation(s.cfg.Timezone)
	if err != nil {
		location = time.UTC
	}
	localNow := now.In(location).Truncate(time.Minute)
	var next time.Time
	for _, task := range s.tasks {
		candidate := task.cron.Next(localNow)
		if next.IsZero() || candidate.Before(next) {
			next = candidate
		}
	}
	return next
}

func (s *Scheduler) dueTasks(now time.Time) []Task {
	location, err := time.LoadLocation(s.cfg.Timezone)
	if err != nil {
		location = time.UTC
	}
	localNow := now.In(location).Truncate(time.Minute)
	var due []Task
	for _, task := range s.tasks {
		previous := localNow.Add(-time.Minute)
		next := task.cron.Next(previous)
		if next.Equal(localNow) {
			due = append(due, task)
		}
	}
	return due
}

func LoadTasks(root string, names []string) ([]Task, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	enabled := map[string]bool{}
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name != "" {
			enabled[name] = true
		}
	}

	var files []string
	for _, entry := range entries {
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), ".md") {
			continue
		}
		files = append(files, entry.Name())
	}
	sort.Strings(files)

	var tasks []Task
	for _, file := range files {
		path := filepath.Join(root, file)
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		task, err := parseTask(path, string(data))
		if err != nil {
			return nil, err
		}
		if len(enabled) > 0 && !enabled[task.Name] {
			continue
		}
		tasks = append(tasks, task)
	}
	return tasks, nil
}

func parseTask(path, content string) (Task, error) {
	task := Task{Path: path}
	content = strings.ReplaceAll(content, "\r\n", "\n")
	if !strings.HasPrefix(content, "---\n") {
		return task, fmt.Errorf("automation %s is missing YAML frontmatter", path)
	}
	rest := strings.TrimPrefix(content, "---\n")
	frontmatter, body, found := strings.Cut(rest, "\n---\n")
	if !found {
		return task, fmt.Errorf("automation %s has unterminated YAML frontmatter", path)
	}
	for _, line := range strings.Split(frontmatter, "\n") {
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		switch strings.TrimSpace(key) {
		case "name":
			task.Name = value
		case "description":
			task.Description = value
		case "schedule":
			task.Schedule = value
		}
	}
	if task.Name == "" {
		return task, fmt.Errorf("automation %s is missing name", path)
	}
	if task.Description == "" {
		return task, fmt.Errorf("automation %s is missing description", path)
	}
	if task.Schedule == "" {
		return task, fmt.Errorf("automation %s is missing schedule", path)
	}
	schedule, err := parseSchedule(task.Schedule)
	if err != nil {
		return task, fmt.Errorf("automation %s schedule: %w", path, err)
	}
	task.cron = schedule
	task.Prompt = strings.TrimSpace(body)
	if task.Prompt == "" {
		return task, fmt.Errorf("automation %s has empty prompt body", path)
	}
	return task, nil
}

func parseSchedule(schedule string) (cron.Schedule, error) {
	schedule = strings.TrimSpace(schedule)
	if strings.HasPrefix(schedule, "cron:") {
		schedule = strings.TrimSpace(strings.TrimPrefix(schedule, "cron:"))
	}
	parser := cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor)
	return parser.Parse(schedule)
}

func taskNames(tasks []Task) string {
	names := make([]string, 0, len(tasks))
	for _, task := range tasks {
		names = append(names, task.Name)
	}
	return strings.Join(names, ",")
}
