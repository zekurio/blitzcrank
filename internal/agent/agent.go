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
	cfg, client, model, reasoningEffort, err := a.runtimeForRequest(req)
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

	for range cfg.MaxToolIterations {
		response, err := client.Chat(ctx, llm.ChatRequest{
			Model:           model,
			ReasoningEffort: reasoningEffort,
			Messages:        messages,
			Tools:           availableTools,
		})
		if err != nil {
			return "", err
		}

		choice := response.FirstChoice()
		if len(choice.Message.ToolCalls) == 0 {
			return strings.TrimSpace(choice.Message.Content), nil
		}

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
