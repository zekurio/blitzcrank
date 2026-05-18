package agent

import (
	"context"
	"fmt"
	"strings"

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
	runtimePrompt := a.runtimeMetadata(model, reasoningEffort, toolPolicy)
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
			Model:           model,
			ReasoningEffort: reasoningEffort,
			Messages:        messages,
			Tools:           availableTools,
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
		for _, call := range choice.Message.ToolCalls {
			result, err := a.executeTool(ctx, req, call, toolPolicy)
			if err != nil {
				result = toolErrorResult(call.Function.Name, err)
			}
			messages = append(messages, llm.Message{
				Role:       "tool",
				Content:    toolResultMessagePayload(result, toolResultMessageLimit),
				ToolCallID: call.ID,
			})
		}
	}

	return "", fmt.Errorf("agent exceeded tool iteration limit")
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
	a.mu.Lock()
	defer a.mu.Unlock()
	a.skills = skills
	return nil
}

func (a *Agent) UpdateConfig(cfg config.Config) {
	a.clientMu.Lock()
	defer a.clientMu.Unlock()
	a.cfg = cfg
	a.client = nil
	a.clients = map[string]llm.Client{}
}
