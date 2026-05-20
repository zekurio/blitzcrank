package automation

import (
	"context"
	"log"
	"path/filepath"
	"strings"
	"time"

	"blitzcrank/internal/agent"
	"blitzcrank/internal/store"
)

type automationRunOutcome struct {
	startedAt   time.Time
	completedAt time.Time
	result      string
	err         error
	silent      bool
}

func (s *Scheduler) runTask(ctx context.Context, task Task) {
	outcome := s.executeAutomationTask(ctx, task)
	if !s.recordAutomationRun(task, outcome) {
		return
	}
	s.deliverAutomationReport(ctx, task, outcome.result)
}

func (s *Scheduler) executeAutomationTask(ctx context.Context, task Task) automationRunOutcome {
	cfg := s.configSnapshot()
	startedAt := time.Now().UTC()
	runCtx, cancel := context.WithTimeout(ctx, cfg.RunTimeout)
	result, err := s.runner.Respond(runCtx, agent.Request{
		Source:   "automation_cron",
		ThreadID: "automation:" + task.Name,
		Author:   "Blitzcrank Scheduler",
		IsAdmin:  true,
		Audience: "automation",
		Content:  s.promptWithHistory(task, cfg),
	})
	cancel()

	return automationRunOutcome{
		startedAt:   startedAt,
		completedAt: time.Now().UTC(),
		result:      result,
		err:         err,
		silent:      isSilentAutomationOutputError(err) || (err == nil && strings.TrimSpace(result) == ""),
	}
}

func (s *Scheduler) recordAutomationRun(task Task, outcome automationRunOutcome) bool {
	tracePath := automationTracePath(task)
	fields := automationRunTraceFields(task, outcome)
	switch {
	case outcome.err != nil && outcome.silent:
		log.Printf("automation task %s completed silently: no report", task.Name)
		s.appendTrace(tracePath, fields)
		return false
	case outcome.err != nil:
		log.Printf("automation task %s failed: %v", task.Name, outcome.err)
		s.appendTrace(tracePath, fields)
		return false
	case outcome.silent:
		log.Printf("automation task %s completed silently: no report", task.Name)
		s.appendTrace(tracePath, fields)
		return false
	default:
		s.appendTrace(tracePath, fields)
		log.Printf("automation task %s completed: %s", task.Name, strings.ReplaceAll(outcome.result, "\n", " "))
		return true
	}
}

func automationRunTraceFields(task Task, outcome automationRunOutcome) map[string]any {
	fields := map[string]any{
		"type":       "automation_run",
		"automation": task.Name,
		"started_at": outcome.startedAt.Format(time.RFC3339Nano),
		"completed":  outcome.completedAt.Format(time.RFC3339Nano),
	}
	switch {
	case outcome.err != nil && outcome.silent:
		fields["result"] = ""
		fields["silent"] = true
	case outcome.err != nil:
		fields["error"] = outcome.err.Error()
	case outcome.silent:
		fields["result"] = ""
		fields["silent"] = true
	default:
		fields["result"] = outcome.result
	}
	return fields
}

func (s *Scheduler) deliverAutomationReport(ctx context.Context, task Task, result string) {
	if s.reporter == nil {
		return
	}
	reportStartedAt := time.Now().UTC()
	reportCtx, reportCancel := context.WithTimeout(ctx, automationRunTimeout)
	defer reportCancel()

	reporterType, err := s.sendAutomationReport(reportCtx, task, result)
	reportCompletedAt := time.Now().UTC()
	if err != nil {
		log.Printf("automation task %s report failed: %v", task.Name, err)
		s.appendTrace(automationTracePath(task), automationReportTraceFields(task, reporterType, reportStartedAt, reportCompletedAt, err))
	} else {
		s.appendTrace(automationTracePath(task), automationReportTraceFields(task, reporterType, reportStartedAt, reportCompletedAt, nil))
	}
}

func (s *Scheduler) sendAutomationReport(ctx context.Context, task Task, result string) (string, error) {
	if automationReporter, ok := s.reporter.(AutomationReporter); ok {
		return "automation_thread", automationReporter.SendAutomationReport(ctx, task.Name, result)
	}
	return "channel", s.reporter.SendMessage(ctx, "[automation: "+task.Name+"]\n\n"+result)
}

func automationReportTraceFields(task Task, reporterType string, startedAt, completedAt time.Time, err error) map[string]any {
	fields := map[string]any{
		"type":       "automation_report_delivery",
		"automation": task.Name,
		"reporter":   reporterType,
		"started_at": startedAt.Format(time.RFC3339Nano),
		"completed":  completedAt.Format(time.RFC3339Nano),
	}
	if err != nil {
		fields["error"] = err.Error()
	} else {
		fields["posted"] = true
	}
	return fields
}

func isSilentAutomationOutputError(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "codex responses completed without assistant output")
}

func (s *Scheduler) appendTrace(relPath string, value any) {
	cfg := s.configSnapshot()
	if err := store.AppendJSONL(filepath.Join(cfg.ThreadsDirectory, relPath), value); err != nil {
		log.Printf("append automation trace %s: %v", relPath, err)
	}
}

func automationTracePath(task Task) string {
	return "automations/" + task.Name + ".jsonl"
}
