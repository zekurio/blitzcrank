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

// Job is a deterministic built-in automation. Unlike Markdown tasks it does
// not invoke Pi: the owning subsystem supplies a typed, read-only operation.
// Jobs share scheduling, overlap protection, manual triggering, and shutdown
// with operator automations without crossing the LLM boundary.
type Job struct {
	Name        string
	Description string
	Schedule    string
	Run         func(context.Context) (string, error)
}

type Scheduler struct {
	cfg          config.Config
	runner       Runner
	reporter     Reporter
	toolFailures ToolFailureStore
	mu           sync.RWMutex
	tasks        map[string]Task
	jobs         map[string]Job
	running      map[string]bool
	loc          *time.Location
	wg           sync.WaitGroup
}

func NewScheduler(cfg config.Config, runner Runner, reporter Reporter) *Scheduler {
	loc, err := time.LoadLocation(strings.TrimSpace(cfg.Timezone))
	if err != nil || loc == nil {
		log.Printf("invalid runtime.timezone %q, falling back to UTC: %v", cfg.Timezone, err)
		loc = time.UTC
	}
	return &Scheduler{cfg: cfg, runner: runner, reporter: reporter, tasks: map[string]Task{}, jobs: map[string]Job{}, running: map[string]bool{}, loc: loc}
}

func (s *Scheduler) RegisterJob(job Job) error {
	job.Name = strings.TrimSpace(job.Name)
	job.Description = strings.TrimSpace(job.Description)
	job.Schedule = strings.TrimSpace(job.Schedule)
	if job.Name == "" {
		return fmt.Errorf("automation job name is required")
	}
	if job.Run == nil {
		return fmt.Errorf("automation job %q runner is required", job.Name)
	}
	if _, err := parseSchedule(job.Schedule); err != nil {
		return fmt.Errorf("parse automation job %q schedule: %w", job.Name, err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.jobs[job.Name]; exists {
		return fmt.Errorf("automation job %q is already registered", job.Name)
	}
	if _, exists := s.tasks[job.Name]; exists {
		return fmt.Errorf("automation job %q conflicts with an operator automation", job.Name)
	}
	s.jobs[job.Name] = job
	return nil
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
	var tasks []Task
	if s.cfg.AutomationsEnabled {
		if err := s.reload(); err != nil {
			log.Printf("load automations: %v", err)
		} else {
			tasks = s.operatorTasksForStart()
		}
	} else {
		log.Printf("operator automations disabled")
	}
	for _, task := range tasks {
		sched, err := parseSchedule(task.Schedule)
		if err != nil {
			log.Printf("automation has invalid schedule, skipping: name=%s schedule=%q error=%v", task.Name, task.Schedule, err)
			continue
		}
		s.launchScheduled(ctx, task.Name, sched)
	}
	for _, job := range s.jobSnapshot() {
		sched, err := parseSchedule(job.Schedule)
		if err != nil {
			log.Printf("built-in automation has invalid schedule, skipping: name=%s schedule=%q error=%v", job.Name, job.Schedule, err)
			continue
		}
		s.launchScheduled(ctx, job.Name, sched)
	}
	log.Printf("automation scheduler started: tasks=%d jobs=%d", len(tasks), len(s.jobSnapshot()))
}

func (s *Scheduler) launchScheduled(ctx context.Context, name string, sched cron.Schedule) {
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.runScheduled(ctx, name, sched)
	}()
}

// Wait joins scheduled loops and any built-in/operator run active inside them.
// The context passed to Start must be canceled before calling Wait.
func (s *Scheduler) Wait() {
	s.wg.Wait()
}

func (s *Scheduler) operatorTasksForStart() []Task {
	if !s.cfg.AutomationsEnabled {
		return nil
	}
	return s.snapshot()
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
	if job, ok := s.registeredJob(name); ok {
		return s.runJob(ctx, job)
	}
	if !s.cfg.AutomationsEnabled {
		return fmt.Errorf("operator automations are disabled")
	}
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

func (s *Scheduler) runJob(ctx context.Context, job Job) error {
	if err := s.beginRun(job.Name); err != nil {
		return err
	}
	defer s.endRun(job.Name)
	runCtx := ctx
	if s.cfg.RunTimeout > 0 {
		var cancel context.CancelFunc
		runCtx, cancel = context.WithTimeout(ctx, s.cfg.RunTimeout)
		defer cancel()
	}
	response, err := job.Run(runCtx)
	if err != nil {
		return err
	}
	if strings.TrimSpace(response) != "" {
		log.Printf("built-in automation completed: name=%s response=%s", job.Name, strings.TrimSpace(response))
	}
	return nil
}

func (s *Scheduler) beginRun(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running[name] {
		return fmt.Errorf("automation %q is already running", name)
	}
	s.running[name] = true
	return nil
}

func (s *Scheduler) endRun(name string) {
	s.mu.Lock()
	delete(s.running, name)
	s.mu.Unlock()
}

func automationMutationBudget(taskBudget, configuredMaximum int) int {
	if configuredMaximum >= 0 && configuredMaximum < taskBudget {
		return configuredMaximum
	}
	return taskBudget
}

func (s *Scheduler) AutomationNames() []string {
	if s.cfg.AutomationsEnabled {
		_ = s.reload()
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	names := make([]string, 0, len(s.tasks)+len(s.jobs))
	for name := range s.tasks {
		names = append(names, name)
	}
	for name := range s.jobs {
		names = append(names, name)
	}
	return names
}

func (s *Scheduler) registeredJob(name string) (Job, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	job, ok := s.jobs[strings.TrimSpace(name)]
	return job, ok
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
	defer s.mu.Unlock()
	for name := range byName {
		if _, exists := s.jobs[name]; exists {
			return fmt.Errorf("operator automation %q conflicts with a built-in automation", name)
		}
	}
	s.tasks = byName
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

func (s *Scheduler) jobSnapshot() []Job {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Job, 0, len(s.jobs))
	for _, job := range s.jobs {
		out = append(out, job)
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
