package harness

import (
	"context"
	"time"
)

type Request struct {
	Source       string
	ThreadID     string
	Author       string
	AuthorID     string
	IsAdmin      bool
	Audience     string
	Content      string
	Context      string
	ToolGroups   []string
	ToolAudit    func(ToolAuditRecord)
	Progress     func(ProgressEvent)
	ToolApproval func(context.Context, ToolApprovalRequest) (ToolApprovalDecision, error)
	SeerrUserID  string
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

type ToolAuditRecord struct {
	Name             string
	Mutating         bool
	ArgumentsSummary string
	ResultSummary    string
	Error            string
	StartedAt        time.Time
	CompletedAt      time.Time
}

type ToolApprovalRequest struct {
	Name             string
	Mutating         bool
	Destructive      bool
	ArgumentsSummary string
}

type ToolApprovalDecision struct {
	Approved bool
	Actor    string
	Reason   string
}
