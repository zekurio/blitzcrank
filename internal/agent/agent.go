package agent

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"blitzcrank/internal/config"
	"blitzcrank/internal/llm"
	"blitzcrank/internal/tools"
)

const toolResultMessageLimit = 24000

func New(cfg config.Config, registry *tools.Registry) (*Agent, error) {
	agent := &Agent{
		cfg:      cfg,
		clients:  map[string]llm.Client{},
		registry: registry,
	}
	if err := agent.loadPromptsAndSkills(); err != nil {
		return nil, err
	}
	return agent, nil
}

func (a *Agent) SetAutomationMetadataProvider(provider AutomationMetadataProvider) {
	a.automationMetadata = provider
}

func (a *Agent) Respond(ctx context.Context, req Request) (string, error) {
	profileName := a.profileNameForRequest(req)
	cfg, client, model, reasoningEffort, err := a.runtimeForProfile(profileName)
	if err != nil {
		return "", err
	}
	toolPolicy := a.toolPolicy(req)
	availableTools := a.registry.OpenAIToolsForPolicy(toolPolicy)
	systemPrompt := a.systemPrompt(req)
	runtimePrompt := a.runtimeMetadata(req, model, reasoningEffort, toolPolicy)
	messageCap := 5
	if cfg.MaxToolIterations > 0 {
		messageCap += cfg.MaxToolIterations * (1 + len(availableTools))
	}
	messages := make([]llm.Message, 0, messageCap)
	messages = append(messages,
		llm.Message{Role: "system", Content: systemPrompt},
		llm.Message{Role: "system", Content: a.workflowPrompt(req, toolPolicy)},
		llm.Message{Role: "system", Content: a.toolContextPrompt(toolPolicy)},
		llm.Message{Role: "system", Content: runtimePrompt},
		llm.Message{Role: "user", Content: requestMessage(req)},
	)

	emitProgress(req, ProgressEvent{Phase: "start", Message: "Reading the request and preparing the tool set."})
	for iteration := range cfg.MaxToolIterations {
		messages = compactMessagesForBudget(cfg.RuntimeContextBudget(profileName), messages)
		emitProgress(req, ProgressEvent{Phase: "model_start", Iteration: iteration + 1, Message: "Asking the model for the next step."})
		response, err := client.Chat(ctx, llm.ChatRequest{
			Model:             model,
			ReasoningEffort:   reasoningEffort,
			Messages:          messages,
			Tools:             availableTools,
			ParallelToolCalls: true,
		})
		if err != nil {
			emitProgress(req, ProgressEvent{Phase: "model_error", Iteration: iteration + 1, Error: err.Error(), Message: "The model request failed."})
			return "", err
		}

		choice := response.FirstChoice()
		if len(choice.Message.ToolCalls) == 0 {
			emitProgress(req, ProgressEvent{Phase: "finalizing", Iteration: iteration + 1, Message: "Composing the final reply."})
			return strings.TrimSpace(choice.Message.Content), nil
		}

		emitProgress(req, ProgressEvent{Phase: "tools_selected", Count: len(choice.Message.ToolCalls), Iteration: iteration + 1, Message: fmt.Sprintf("model selected %d tool calls", len(choice.Message.ToolCalls))})
		messages = append(messages, choice.Message)
		results := a.executeToolCalls(ctx, req, choice.Message.ToolCalls, toolPolicy)
		for i, call := range choice.Message.ToolCalls {
			messages = append(messages, llm.Message{
				Role:       "tool",
				Content:    toolResultMessagePayload(results[i], toolResultMessageLimit),
				ToolCallID: call.ID,
			})
		}
	}

	return "", fmt.Errorf("agent exceeded tool iteration limit")
}

func (a *Agent) executeToolCalls(ctx context.Context, req Request, calls []llm.ToolCall, policy tools.ToolPolicy) []any {
	results := make([]any, len(calls))
	if len(calls) == 0 {
		return results
	}
	if len(calls) == 1 || !a.canExecuteToolCallsInParallel(calls) {
		for i, call := range calls {
			result, err := a.executeTool(ctx, req, call, policy)
			if err != nil {
				result = toolErrorResult(call.Function.Name, err)
			}
			results[i] = result
		}
		return results
	}

	var wg sync.WaitGroup
	parallelReq := requestWithSerializedCallbacks(req)
	for i, call := range calls {
		i, call := i, call
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := a.executeTool(ctx, parallelReq, call, policy)
			if err != nil {
				result = toolErrorResult(call.Function.Name, err)
			}
			results[i] = result
		}()
	}
	wg.Wait()
	return results
}

func requestWithSerializedCallbacks(req Request) Request {
	if req.Progress == nil && req.ToolAudit == nil {
		return req
	}
	var mu sync.Mutex
	if progress := req.Progress; progress != nil {
		req.Progress = func(event ProgressEvent) {
			mu.Lock()
			defer mu.Unlock()
			progress(event)
		}
	}
	if audit := req.ToolAudit; audit != nil {
		req.ToolAudit = func(record ToolAuditRecord) {
			mu.Lock()
			defer mu.Unlock()
			audit(record)
		}
	}
	return req
}

func (a *Agent) canExecuteToolCallsInParallel(calls []llm.ToolCall) bool {
	for _, call := range calls {
		name := call.Function.Name
		if a.registry.IsMutatingTool(name) || a.registry.RequiresApproval(name) {
			return false
		}
	}
	return true
}

func emitProgress(req Request, event ProgressEvent) {
	if req.Progress != nil {
		req.Progress(event)
	}
}

func (a *Agent) ReloadSkills() error {
	cfg := a.configSnapshot()
	skills, err := LoadRuntimeSkills(cfg)
	if err != nil {
		return err
	}
	discordTriagePrompt, err := LoadPromptTemplate(discordTriagePromptPath)
	if err != nil {
		return err
	}
	discordTriagePrompt = renderPrompt(discordTriagePrompt, map[string]string{
		"bot_name":      cfg.BotPublicName,
		"skill_catalog": triageSkillCatalog(skills),
	})
	a.mu.Lock()
	defer a.mu.Unlock()
	a.skills = skills
	a.discordTriagePrompt = discordTriagePrompt
	return nil
}

func (a *Agent) UpdateConfig(cfg config.Config) {
	a.clientMu.Lock()
	defer a.clientMu.Unlock()
	a.cfg = cfg
	a.client = nil
	a.clients = map[string]llm.Client{}
}
