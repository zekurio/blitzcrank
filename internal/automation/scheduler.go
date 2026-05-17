package automation

import (
	"context"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"

	"blitzcrank/internal/agent"
	"blitzcrank/internal/config"
	"blitzcrank/internal/store"
	"github.com/robfig/cron/v3"
)

const (
	automationRunTimeout = 30 * time.Second
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
	lastDueCheck  time.Time
	runWG         sync.WaitGroup
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
	cfg := s.configSnapshot()
	if !cfg.AutomationsEnabled {
		log.Printf("automation scheduler disabled")
		go s.loop(ctx)
		return
	}
	tasks := s.taskSnapshot()
	if len(tasks) == 0 {
		log.Printf("automation scheduler enabled with no tasks; watching automation directories")
	} else {
		log.Printf("automation scheduler enabled: tasks=%s timezone=%s", taskNames(tasks), cfg.Timezone)
	}

	go s.loop(ctx)
}

func (s *Scheduler) loop(ctx context.Context) {
	for {
		if !s.cronEnabled() {
			timer := time.NewTimer(time.Minute)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
				s.reloadTasks()
				continue
			}
		}
		next := s.nextRun(time.Now())
		wakeAt := nextReload(time.Now(), next)
		timer := time.NewTimer(time.Until(wakeAt))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
			s.reloadTasks()
			if !s.cronEnabled() {
				continue
			}
			s.runDue(ctx, time.Now())
		}
	}
}

func (s *Scheduler) cronEnabled() bool {
	return s.configSnapshot().AutomationsEnabled
}

func nextReload(now, nextRun time.Time) time.Time {
	nextReload := now.Truncate(time.Minute).Add(time.Minute)
	if nextRun.IsZero() || nextReload.Before(nextRun) {
		return nextReload
	}
	return nextRun
}

func (s *Scheduler) reloadTasks() {
	if err := s.Reload(); err != nil {
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
}

func (s *Scheduler) Reload() error {
	cfg := s.configSnapshot()
	tasks, err := LoadTaskDirs(cfg.AutomationsDirectory, cfg.AutomationsExtraDirs)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastLoadError = ""
	if sameTaskSet(s.tasks, tasks) {
		return nil
	}
	s.tasks = tasks
	if len(tasks) == 0 {
		log.Printf("automation tasks reloaded: none")
		return nil
	}
	log.Printf("automation tasks reloaded: %s", taskNames(tasks))
	return nil
}

func (s *Scheduler) ReloadAutomations() error {
	return s.Reload()
}

func (s *Scheduler) UpdateConfig(cfg config.Config) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cfg = cfg
}

func (s *Scheduler) RunAutomation(ctx context.Context, name string) error {
	name = strings.TrimSpace(name)
	for _, task := range s.taskSnapshot() {
		if task.Name == name {
			s.runTask(ctx, task)
			return nil
		}
	}
	return fmt.Errorf("automation %q not found", name)
}

func (s *Scheduler) AutomationNames() []string {
	tasks := s.taskSnapshot()
	names := make([]string, 0, len(tasks))
	for _, task := range tasks {
		names = append(names, task.Name)
	}
	sort.Strings(names)
	return names
}

func (s *Scheduler) AutomationStatus(now time.Time) string {
	metadata := s.AutomationRuntimeMetadata(now)
	if !metadata.Enabled {
		return "disabled"
	}
	if strings.TrimSpace(metadata.Error) != "" {
		return "enabled with load error: " + metadata.Error
	}
	if len(metadata.Tasks) == 0 {
		return "enabled; no tasks loaded"
	}
	lines := make([]string, 0, len(metadata.Tasks))
	for _, task := range metadata.Tasks {
		next := "unknown"
		if !task.NextRun.IsZero() {
			next = task.NextRun.Format(time.RFC3339)
		}
		lines = append(lines, fmt.Sprintf("%s: %s; next=%s", task.Name, task.Schedule, next))
	}
	return strings.Join(lines, "\n")
}

func (s *Scheduler) runDue(ctx context.Context, now time.Time) {
	for _, task := range s.dueTasks(now) {
		task := task
		s.runWG.Add(1)
		go func() {
			defer s.runWG.Done()
			s.runTask(ctx, task)
		}()
	}
}

func (s *Scheduler) nextRun(now time.Time) time.Time {
	cfg, tasks, _ := s.schedulerSnapshot()
	return nextRunForTasks(cfg.Timezone, now, tasks)
}

func (s *Scheduler) nextRunForTasks(now time.Time, tasks []Task) time.Time {
	cfg := s.configSnapshot()
	return nextRunForTasks(cfg.Timezone, now, tasks)
}

func nextRunForTasks(timezone string, now time.Time, tasks []Task) time.Time {
	location, err := time.LoadLocation(timezone)
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
	s.mu.Lock()
	cfg := s.cfg
	tasks := append([]Task(nil), s.tasks...)
	since := s.lastDueCheck
	if since.IsZero() {
		since = now.Add(-time.Minute)
	}
	s.lastDueCheck = now
	s.mu.Unlock()

	location, err := time.LoadLocation(cfg.Timezone)
	if err != nil {
		location = time.UTC
	}
	localSince := since.In(location).Truncate(time.Minute)
	localNow := now.In(location).Truncate(time.Minute)
	due := make([]Task, 0, len(tasks))
	for _, task := range tasks {
		next := task.cron.Next(localSince)
		if !next.After(localNow) {
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
	cfg, tasks, lastLoadError := s.schedulerSnapshot()

	metadata := agent.AutomationRuntimeMetadata{
		Enabled:  cfg.AutomationsEnabled,
		Timezone: cfg.Timezone,
		Error:    lastLoadError,
	}
	if !cfg.AutomationsEnabled || lastLoadError != "" {
		return metadata
	}
	metadata.Tasks = make([]agent.AutomationTaskMetadata, 0, len(tasks))
	for _, task := range tasks {
		metadata.Tasks = append(metadata.Tasks, agent.AutomationTaskMetadata{
			Name:        task.Name,
			Description: task.Description,
			Schedule:    task.Schedule,
			Path:        task.Path,
			NextRun:     nextRunForTasks(cfg.Timezone, now, []Task{task}),
		})
	}
	return metadata
}

func (s *Scheduler) configSnapshot() config.Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cfg
}

func (s *Scheduler) schedulerSnapshot() (config.Config, []Task, string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cfg, append([]Task(nil), s.tasks...), s.lastLoadError
}

func (s *Scheduler) waitForRuns() {
	s.runWG.Wait()
}
