package automation

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	assets "blitzcrank"
	"blitzcrank/internal/agent"
	"blitzcrank/internal/config"
	"blitzcrank/internal/store"
	"github.com/robfig/cron/v3"
)

type Reporter interface {
	SendMessage(context.Context, string) error
}

type AutomationReporter interface {
	SendAutomationReport(context.Context, string, string) error
}

type Runner interface {
	Respond(context.Context, agent.Request) (string, error)
}

type Scheduler struct {
	mu            sync.RWMutex
	cfg           config.Config
	runner        Runner
	reporter      Reporter
	tasks         []Task
	lastLoadError string
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
	scheduler := &Scheduler{
		cfg:      cfg,
		runner:   runner,
		reporter: reporter,
	}
	scheduler.reloadTasks()
	return scheduler
}

func (s *Scheduler) Start(ctx context.Context) {
	if !s.cfg.CronEnabled {
		log.Printf("automation scheduler disabled")
		return
	}
	tasks := s.taskSnapshot()
	if len(tasks) == 0 {
		log.Printf("automation scheduler enabled with no tasks; watching automation directories")
	} else {
		log.Printf("automation scheduler enabled: tasks=%s timezone=%s", taskNames(tasks), s.cfg.Timezone)
	}

	go s.loop(ctx)
}

func (s *Scheduler) loop(ctx context.Context) {
	for {
		s.reloadTasks()
		next := s.nextRun(time.Now())
		wakeAt := nextReload(time.Now(), next)
		timer := time.NewTimer(time.Until(wakeAt))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
			s.reloadTasks()
			s.runDue(ctx, time.Now())
		}
	}
}

func nextReload(now, nextRun time.Time) time.Time {
	nextReload := now.Truncate(time.Minute).Add(time.Minute)
	if nextRun.IsZero() || nextReload.Before(nextRun) {
		return nextReload
	}
	return nextRun
}

func (s *Scheduler) reloadTasks() {
	tasks, err := LoadTaskDirs(s.cfg.AutomationsExtraDirs)
	if err != nil {
		message := err.Error()
		s.mu.Lock()
		changed := message != s.lastLoadError
		s.lastLoadError = message
		s.mu.Unlock()
		if changed {
			log.Printf("load automations: %v", err)
		}
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastLoadError = ""
	if sameTaskSet(s.tasks, tasks) {
		return
	}
	s.tasks = tasks
	if len(tasks) == 0 {
		log.Printf("automation tasks reloaded: none")
		return
	}
	log.Printf("automation tasks reloaded: %s", taskNames(tasks))
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
			s.appendTrace("automations/"+task.Name+".jsonl", map[string]any{
				"type":       "automation_run",
				"automation": task.Name,
				"started_at": startedAt.Format(time.RFC3339Nano),
				"completed":  completedAt.Format(time.RFC3339Nano),
				"error":      err.Error(),
			})
			continue
		}
		s.appendTrace("automations/"+task.Name+".jsonl", map[string]any{
			"type":       "automation_run",
			"automation": task.Name,
			"started_at": startedAt.Format(time.RFC3339Nano),
			"completed":  completedAt.Format(time.RFC3339Nano),
			"result":     result,
		})
		log.Printf("automation task %s completed: %s", task.Name, strings.ReplaceAll(result, "\n", " "))
		if s.reporter != nil {
			reportStartedAt := time.Now().UTC()
			reportCtx, reportCancel := context.WithTimeout(context.Background(), 30*time.Second)
			var err error
			reporterType := "channel"
			if automationReporter, ok := s.reporter.(AutomationReporter); ok {
				reporterType = "automation_thread"
				err = automationReporter.SendAutomationReport(reportCtx, task.Name, result)
			} else {
				err = s.reporter.SendMessage(reportCtx, "[automation: "+task.Name+"]\n\n"+result)
			}
			reportCompletedAt := time.Now().UTC()
			if err != nil {
				log.Printf("automation task %s report failed: %v", task.Name, err)
				s.appendTrace("automations/"+task.Name+".jsonl", map[string]any{
					"type":       "automation_report_delivery",
					"automation": task.Name,
					"reporter":   reporterType,
					"started_at": reportStartedAt.Format(time.RFC3339Nano),
					"completed":  reportCompletedAt.Format(time.RFC3339Nano),
					"error":      err.Error(),
				})
			} else {
				s.appendTrace("automations/"+task.Name+".jsonl", map[string]any{
					"type":       "automation_report_delivery",
					"automation": task.Name,
					"reporter":   reporterType,
					"started_at": reportStartedAt.Format(time.RFC3339Nano),
					"completed":  reportCompletedAt.Format(time.RFC3339Nano),
					"posted":     true,
				})
			}
			reportCancel()
		}
	}
}

func (s *Scheduler) appendTrace(relPath string, value any) {
	if err := store.AppendJSONL(filepath.Join(s.cfg.ThreadsDirectory, relPath), value); err != nil {
		log.Printf("append automation trace %s: %v", relPath, err)
	}
}

func (s *Scheduler) nextRun(now time.Time) time.Time {
	return s.nextRunForTasks(now, s.taskSnapshot())
}

func (s *Scheduler) nextRunForTasks(now time.Time, tasks []Task) time.Time {
	location, err := time.LoadLocation(s.cfg.Timezone)
	if err != nil {
		location = time.UTC
	}
	localNow := now.In(location).Truncate(time.Minute)
	var next time.Time
	for _, task := range tasks {
		candidate := task.cron.Next(localNow)
		if next.IsZero() || candidate.Before(next) {
			next = candidate
		}
	}
	return next
}

func (s *Scheduler) dueTasks(now time.Time) []Task {
	tasks := s.taskSnapshot()
	location, err := time.LoadLocation(s.cfg.Timezone)
	if err != nil {
		location = time.UTC
	}
	localNow := now.In(location).Truncate(time.Minute)
	var due []Task
	for _, task := range tasks {
		previous := localNow.Add(-time.Minute)
		next := task.cron.Next(previous)
		if next.Equal(localNow) {
			due = append(due, task)
		}
	}
	return due
}

func (s *Scheduler) taskSnapshot() []Task {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]Task(nil), s.tasks...)
}

func (s *Scheduler) AutomationRuntimeMetadata(now time.Time) agent.AutomationRuntimeMetadata {
	s.mu.RLock()
	tasks := append([]Task(nil), s.tasks...)
	lastLoadError := s.lastLoadError
	s.mu.RUnlock()

	metadata := agent.AutomationRuntimeMetadata{
		Enabled:  s.cfg.CronEnabled,
		Timezone: s.cfg.Timezone,
		Error:    lastLoadError,
	}
	if !s.cfg.CronEnabled || lastLoadError != "" {
		return metadata
	}
	for _, task := range tasks {
		metadata.Tasks = append(metadata.Tasks, agent.AutomationTaskMetadata{
			Name:        task.Name,
			Description: task.Description,
			Schedule:    task.Schedule,
			Path:        task.Path,
			NextRun:     s.nextRunForTasks(now, []Task{task}),
		})
	}
	return metadata
}

func LoadTasks(root string) ([]Task, error) {
	tasks, err := loadTasksFromFS(os.DirFS(root), ".", root)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	return tasks, nil
}

func LoadTaskDirs(extraRoots []string) ([]Task, error) {
	all, err := loadTasksFromFS(assets.FS, "automations", "automations")
	if err != nil {
		return nil, err
	}
	for _, extraRoot := range extraRoots {
		extraRoot = strings.TrimSpace(extraRoot)
		if extraRoot == "" {
			continue
		}
		tasks, err := LoadTasks(extraRoot)
		if err != nil {
			return nil, err
		}
		all = append(all, tasks...)
	}
	if err := rejectDuplicateTasks(all); err != nil {
		return nil, err
	}
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].Name == all[j].Name {
			return all[i].Path < all[j].Path
		}
		return all[i].Name < all[j].Name
	})
	return all, nil
}

func rejectDuplicateTasks(tasks []Task) error {
	seen := map[string]string{}
	for _, task := range tasks {
		name := strings.TrimSpace(task.Name)
		if previous, ok := seen[name]; ok {
			return fmt.Errorf("duplicate automation %q in %s and %s", name, previous, task.Path)
		}
		seen[name] = task.Path
	}
	return nil
}

func sameTaskSet(a, b []Task) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Name != b[i].Name ||
			a[i].Description != b[i].Description ||
			a[i].Schedule != b[i].Schedule ||
			a[i].Prompt != b[i].Prompt ||
			a[i].Path != b[i].Path {
			return false
		}
	}
	return true
}

func loadTasksFromFS(fsys fs.FS, root, displayRoot string) ([]Task, error) {
	entries, err := fs.ReadDir(fsys, root)
	if err != nil {
		return nil, err
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
		readPath := fsPath(root, file)
		data, err := fs.ReadFile(fsys, readPath)
		if err != nil {
			return nil, err
		}
		task, err := parseTask(displayPath(displayRoot, file), string(data))
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, task)
	}
	return tasks, nil
}

func fsPath(parts ...string) string {
	var clean []string
	for _, part := range parts {
		part = strings.Trim(part, "/")
		if part != "" && part != "." {
			clean = append(clean, part)
		}
	}
	if len(clean) == 0 {
		return "."
	}
	return strings.Join(clean, "/")
}

func displayPath(root string, parts ...string) string {
	if root == "" || root == "." {
		return filepath.Join(parts...)
	}
	return filepath.Join(append([]string{root}, parts...)...)
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
