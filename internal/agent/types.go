package agent

import (
	"context"
	"sync"
	"time"

	"blitzcrank/internal/config"
	"blitzcrank/internal/llm"
	"blitzcrank/internal/tools"
)

type Agent struct {
	cfg                  config.Config
	client               llm.Client
	clients              map[string]llm.Client
	clientMu             sync.Mutex
	registry             *tools.Registry
	mu                   sync.RWMutex
	automationMetadata   AutomationMetadataProvider
	system               string
	skills               []Skill
	runtimePrompt        string
	discordTriagePrompt  string
	discordSummaryPrompt string
}

type Request struct {
	Source       string
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
	Phase     string
	Message   string
	ToolName  string
	Count     int
	Iteration int
	StartedAt time.Time
	Duration  time.Duration
	Error     string
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

type AutomationMetadataProvider interface {
	AutomationRuntimeMetadata(time.Time) AutomationRuntimeMetadata
}

type AutomationRuntimeMetadata struct {
	Enabled  bool
	Timezone string
	Tasks    []AutomationTaskMetadata
	Error    string
}

type AutomationTaskMetadata struct {
	Name        string
	Description string
	Schedule    string
	Path        string
	NextRun     time.Time
}

type DiscordTriageRequest struct {
	Author  string
	Content string
	Mention bool
}

type DiscordTriageResult struct {
	Action        string  `json:"action"`
	Actionable    bool    `json:"actionable"`
	Confidence    float64 `json:"confidence"`
	Reason        string  `json:"reason"`
	ThreadTitle   string  `json:"thread_title"`
	NeedsAgentRun bool    `json:"needs_agent_run"`
	Reply         string  `json:"reply"`
}
