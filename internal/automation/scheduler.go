package automation

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/robfig/cron/v3"

	"blitzcrank/internal/config"
	"blitzcrank/internal/harness"
)

type Runner interface {
	Respond(context.Context, harness.Request) (string, error)
}

type ToolFailure struct {
	Tool  string
	Error string
}

type ReportHandle struct {
	ThreadID  string
	MessageID string
}

type Reporter interface {
	AutomationStarted(context.Context, Task) (ReportHandle, error)
	AutomationCompleted(context.Context, ReportHandle, Task, string, error, []ToolFailure) error
}

type ToolFailureStore interface {
	ResetToolFailures(threadID string)
	DrainToolFailures(threadID string) []ToolFailure
	RecordToolFailure(threadID string, failure ToolFailure)
}

type Scheduler struct {
	cfg          config.Config
	runner       Runner
	reporter     Reporter
	toolFailures ToolFailureStore
	mu           sync.RWMutex
	tasks        map[string]Task
	running      map[string]bool
	loc          *time.Location
}

func NewScheduler(cfg config.Config, runner Runner, reporter Reporter) *Scheduler {
	loc, err := time.LoadLocation(strings.TrimSpace(cfg.Timezone))
	if err != nil || loc == nil {
		log.Printf("invalid runtime.timezone %q, falling back to UTC: %v", cfg.Timezone, err)
		loc = time.UTC
	}
	return &Scheduler{cfg: cfg, runner: runner, reporter: reporter, tasks: map[string]Task{}, running: map[string]bool{}, loc: loc}
}

func (s *Scheduler) SetReporter(reporter Reporter) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reporter = reporter
}

func (s *Scheduler) SetToolFailureStore(store ToolFailureStore) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.toolFailures = store
}

func (s *Scheduler) Start(ctx context.Context) {
	if !s.cfg.AutomationsEnabled {
		log.Printf("automation scheduler disabled")
		return
	}
	if err := s.reload(); err != nil {
		log.Printf("load automations: %v", err)
		return
	}
	for _, task := range s.snapshot() {
		sched, err := parseSchedule(task.Schedule)
		if err != nil {
			log.Printf("automation has invalid schedule, skipping: name=%s schedule=%q error=%v", task.Name, task.Schedule, err)
			continue
		}
		go s.runScheduled(ctx, task.Name, sched)
	}
	log.Printf("automation scheduler started: tasks=%d", len(s.snapshot()))
}

func parseSchedule(spec string) (cron.Schedule, error) {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return nil, fmt.Errorf("schedule is empty")
	}
	return cron.ParseStandard(spec)
}

// Schedules are read once at Start; RunAutomation reloads task bodies per
// run, but schedule changes require a restart (matches previous behavior).
func (s *Scheduler) runScheduled(ctx context.Context, name string, sched cron.Schedule) {
	for {
		next := sched.Next(time.Now().In(s.loc))
		log.Printf("automation scheduled: name=%s next_run=%s", name, next.Format(time.RFC3339))
		timer := time.NewTimer(time.Until(next))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		if err := s.RunAutomation(ctx, name); err != nil {
			log.Printf("automation failed: name=%s error=%v", name, err)
		}
	}
}

func (s *Scheduler) RunAutomation(ctx context.Context, name string) error {
	if err := s.reload(); err != nil {
		return err
	}
	s.mu.RLock()
	task, ok := s.tasks[name]
	s.mu.RUnlock()
	if !ok {
		return fmt.Errorf("unknown automation %q", name)
	}
	s.mu.Lock()
	if s.running[task.Name] {
		s.mu.Unlock()
		return fmt.Errorf("automation %q is already running", task.Name)
	}
	s.running[task.Name] = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.running, task.Name)
		s.mu.Unlock()
	}()
	runCtx := ctx
	if s.cfg.RunTimeout > 0 {
		var cancel context.CancelFunc
		runCtx, cancel = context.WithTimeout(ctx, s.cfg.RunTimeout)
		defer cancel()
	}
	threadID := "automation:" + task.Name
	if store := s.currentToolFailureStore(); store != nil {
		store.ResetToolFailures(threadID)
	}
	reportHandle := ReportHandle{}
	reporter := s.currentReporter()
	if reporter != nil {
		handle, err := reporter.AutomationStarted(runCtx, task)
		if err != nil {
			log.Printf("automation reporter start failed: name=%s error=%v", task.Name, err)
		} else {
			reportHandle = handle
		}
	}
	effectiveTask := task
	effectiveTask.MutationBudget = automationMutationBudget(task.MutationBudget, s.cfg.AutomationMutationBudget)
	prompt := automationPrompt(effectiveTask)
	request := harness.Request{
		Source:         "automation_cron",
		ThreadID:       threadID,
		Author:         "scheduler",
		ActorID:        "scheduler",
		Audience:       "automation",
		Content:        prompt,
		Authority:      prompt,
		Capabilities:   append([]string(nil), task.Capabilities...),
		MutationPolicy: task.MutationPolicy,
		MutationBudget: effectiveTask.MutationBudget,
	}
	if store := s.currentToolFailureStore(); store != nil {
		request.Progress = func(event harness.ProgressEvent) {
			if event.Phase == "tool_done" && strings.TrimSpace(event.Error) != "" {
				store.RecordToolFailure(threadID, ToolFailure{Tool: event.ToolName, Error: event.Error})
			}
		}
	}
	response, err := s.runner.Respond(runCtx, request)
	var failures []ToolFailure
	if store := s.currentToolFailureStore(); store != nil {
		failures = store.DrainToolFailures(threadID)
	}
	if reporter != nil {
		if reportErr := reporter.AutomationCompleted(runCtx, reportHandle, task, response, err, failures); reportErr != nil {
			log.Printf("automation reporter completion failed: name=%s error=%v", task.Name, reportErr)
		}
	}
	if err != nil {
		return err
	}
	if strings.TrimSpace(response) != "" {
		log.Printf("automation completed: name=%s response=%s", task.Name, strings.TrimSpace(response))
	}
	return nil
}

func automationMutationBudget(taskBudget, configuredMaximum int) int {
	if configuredMaximum >= 0 && configuredMaximum < taskBudget {
		return configuredMaximum
	}
	return taskBudget
}

func (s *Scheduler) AutomationNames() []string {
	_ = s.reload()
	s.mu.RLock()
	defer s.mu.RUnlock()
	names := make([]string, 0, len(s.tasks))
	for name := range s.tasks {
		names = append(names, name)
	}
	return names
}

func (s *Scheduler) reload() error {
	tasks, err := LoadTasks(s.cfg)
	if err != nil {
		return err
	}
	byName := make(map[string]Task, len(tasks))
	for _, task := range tasks {
		byName[task.Name] = task
	}
	s.mu.Lock()
	s.tasks = byName
	s.mu.Unlock()
	return nil
}

func (s *Scheduler) currentReporter() Reporter {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.reporter
}

func (s *Scheduler) currentToolFailureStore() ToolFailureStore {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.toolFailures
}

func (s *Scheduler) snapshot() []Task {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Task, 0, len(s.tasks))
	for _, task := range s.tasks {
		out = append(out, task)
	}
	return out
}

func automationPrompt(task Task) string {
	var b strings.Builder
	b.WriteString("Run this Blitzcrank automation. Treat the automation body as trusted operator instructions.\n\n")
	b.WriteString("Automation: " + task.Name + "\n")
	if task.Description != "" {
		b.WriteString("Description: " + task.Description + "\n")
	}
	b.WriteString("Schedule: " + task.Schedule + "\n")
	b.WriteString(fmt.Sprintf("Mutation budget: %d\n", task.MutationBudget))
	if task.MutationPolicy != "" {
		b.WriteString("Mutation policy: " + task.MutationPolicy + "\n")
	}
	if len(task.Capabilities) > 0 {
		b.WriteString("Declared capabilities: " + strings.Join(task.Capabilities, ", ") + "\n")
	}
	b.WriteString("\n")
	b.WriteString(task.Body)
	return b.String()
}
