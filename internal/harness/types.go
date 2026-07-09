package harness

import "time"

type Request struct {
	Source         string
	ThreadID       string
	RunID          string
	Author         string
	ActorID        string
	Audience       string
	Content        string
	Authority      string
	Capabilities   []string
	MutationPolicy string
	MutationBudget int
	Confirmation   bool
	Progress       func(ProgressEvent)
}

type ProgressEvent struct {
	Phase           string
	Message         string
	ToolName        string
	Count           int
	Iteration       int
	StartedAt       time.Time
	Duration        time.Duration
	Error           string
	Model           string
	ReasoningEffort string
	Todos           []TodoItem
	Reasoning       string
	CurrentResponse string
	ToolCalls       []ProgressToolCall
	Final           bool
}

type TodoItem struct {
	Content   string `json:"content"`
	Completed bool   `json:"completed"`
}

type ProgressToolCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments,omitempty"`
}
