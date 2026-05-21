package automation

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"blitzcrank/internal/config"
	"blitzcrank/internal/harness"
)

type Runner interface {
	Respond(context.Context, harness.Request) (string, error)
}

type Reporter interface {
	AutomationStarted(context.Context, Task) (string, error)
	AutomationCompleted(context.Context, string, Task, string, error) error
}

type Scheduler struct {
	cfg      config.Config
	runner   Runner
	reporter Reporter
	mu       sync.RWMutex
	tasks    map[string]Task
}

func NewScheduler(cfg config.Config, runner Runner, reporter Reporter) *Scheduler {
	return &Scheduler{cfg: cfg, runner: runner, reporter: reporter, tasks: map[string]Task{}}
}

func (s *Scheduler) SetReporter(reporter Reporter) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reporter = reporter
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
		if strings.EqualFold(strings.TrimSpace(task.Schedule), "@hourly") {
			go s.runHourly(ctx, task.Name)
		}
	}
	log.Printf("automation scheduler started: tasks=%d", len(s.snapshot()))
}

func (s *Scheduler) runHourly(ctx context.Context, name string) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.RunAutomation(ctx, name); err != nil {
				log.Printf("automation failed: name=%s error=%v", name, err)
			}
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
	threadID := ""
	reporter := s.currentReporter()
	if reporter != nil {
		id, err := reporter.AutomationStarted(ctx, task)
		if err != nil {
			log.Printf("automation reporter start failed: name=%s error=%v", task.Name, err)
		} else {
			threadID = id
		}
	}
	response, err := s.runner.Respond(ctx, harness.Request{
		Source:   "automation_cron",
		ThreadID: "automation:" + task.Name,
		Author:   "scheduler",
		Audience: "automation",
		Content:  automationPrompt(task),
	})
	if reporter != nil {
		if reportErr := reporter.AutomationCompleted(ctx, threadID, task, response, err); reportErr != nil {
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

func (s *Scheduler) AutomationNames() []string {
	_ = s.reload()
	names := make([]string, 0, len(s.tasks))
	s.mu.RLock()
	defer s.mu.RUnlock()
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
	b.WriteString("Schedule: " + task.Schedule + "\n\n")
	b.WriteString(task.Body)
	return b.String()
}
