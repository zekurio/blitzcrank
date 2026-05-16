package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"blitzcrank/internal/config"
	"blitzcrank/internal/llm"
	"blitzcrank/internal/tools"
)

type Agent struct {
	cfg      config.Config
	client   llm.Client
	registry *tools.Registry
	system   string
	skills   []Skill
}

type Request struct {
	Source  string
	Author  string
	Content string
	Skill   string
}

func New(cfg config.Config, registry *tools.Registry) (*Agent, error) {
	skills, err := LoadSkills(cfg.SkillsDirectory)
	if err != nil {
		return nil, err
	}
	prompt, err := LoadPromptTemplate(cfg.SystemPromptPath)
	if err != nil {
		return nil, err
	}
	system := BuildSystemPrompt(cfg, prompt, skills)
	client, err := llm.New(cfg)
	if err != nil {
		return nil, err
	}
	return &Agent{
		cfg:      cfg,
		client:   client,
		registry: registry,
		system:   system,
		skills:   skills,
	}, nil
}

func (a *Agent) Respond(ctx context.Context, req Request) (string, error) {
	messages := []llm.Message{
		{Role: "system", Content: a.system},
		{Role: "user", Content: fmt.Sprintf("Source: %s\nAuthor: %s\n\n%s", req.Source, req.Author, req.Content)},
	}

	for range a.cfg.MaxToolIterations {
		model := a.ModelName(req)
		response, err := a.client.Chat(ctx, llm.ChatRequest{
			Model:           model,
			ReasoningEffort: a.ReasoningEffort(req, model),
			Messages:        messages,
			Tools:           a.registry.OpenAITools(),
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
			result, err := a.executeTool(ctx, call)
			if err != nil {
				result = map[string]any{"error": err.Error()}
			}
			payload, _ := json.Marshal(result)
			messages = append(messages, llm.Message{
				Role:       "tool",
				Content:    string(payload),
				ToolCallID: call.ID,
			})
		}
	}

	return "", fmt.Errorf("agent exceeded tool iteration limit")
}

func (a *Agent) executeTool(ctx context.Context, call llm.ToolCall) (any, error) {
	var args map[string]any
	if call.Function.Arguments != "" {
		if err := json.Unmarshal([]byte(call.Function.Arguments), &args); err != nil {
			return nil, fmt.Errorf("parse tool arguments for %s: %w", call.Function.Name, err)
		}
	}
	log.Printf("agent tool call: %s", call.Function.Name)
	return a.registry.Call(ctx, call.Function.Name, args)
}

func (a *Agent) ModelName(req Request) string {
	return ModelForRequest(a.skills, req, a.cfg.Model)
}

func (a *Agent) ReasoningEffort(req Request, model string) string {
	return ReasoningEffortForRequest(a.skills, req, a.cfg.ReasoningEffort, model)
}

func ModelForRequest(skills []Skill, req Request, fallback string) string {
	skillName := strings.TrimSpace(req.Skill)
	if skillName == "" {
		return strings.TrimSpace(fallback)
	}
	for _, skill := range skills {
		if strings.EqualFold(skill.Name, skillName) && strings.TrimSpace(skill.Model) != "" {
			return strings.TrimSpace(skill.Model)
		}
	}
	return strings.TrimSpace(fallback)
}

func ReasoningEffortForRequest(skills []Skill, req Request, fallback, model string) string {
	skillName := strings.TrimSpace(req.Skill)
	if skillName != "" {
		for _, skill := range skills {
			if strings.EqualFold(skill.Name, skillName) && strings.TrimSpace(skill.ReasoningEffort) != "" {
				return strings.TrimSpace(skill.ReasoningEffort)
			}
		}
	}
	if strings.TrimSpace(fallback) != "" {
		return strings.TrimSpace(fallback)
	}
	return RecommendedReasoningEffort(model)
}

func RecommendedReasoningEffort(model string) string {
	model = normalizedModelName(model)
	switch {
	case model == "gpt-5.4-mini" || strings.HasPrefix(model, "gpt-5.4-mini-"):
		return "high"
	case model == "gpt-5.4" || strings.HasPrefix(model, "gpt-5.4-"):
		return "medium"
	case model == "gpt-5.5" || strings.HasPrefix(model, "gpt-5.5-"):
		return "low"
	default:
		return ""
	}
}

func normalizedModelName(model string) string {
	model = strings.ToLower(strings.TrimSpace(model))
	if _, suffix, ok := strings.Cut(model, "/"); ok {
		model = suffix
	}
	if prefix, _, ok := strings.Cut(model, ":"); ok {
		model = prefix
	}
	return model
}

func LoadSystemPrompt(cfg config.Config) (string, error) {
	skills, err := LoadSkills(cfg.SkillsDirectory)
	if err != nil {
		return "", err
	}
	prompt, err := LoadPromptTemplate(cfg.SystemPromptPath)
	if err != nil {
		return "", err
	}
	return BuildSystemPrompt(cfg, prompt, skills), nil
}

func LoadPromptTemplate(path string) (string, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("load system prompt %s: %w", path, err)
	}
	return strings.TrimSpace(string(content)), nil
}

func BuildSystemPrompt(cfg config.Config, promptTemplate string, skills []Skill) string {
	prompt := strings.TrimSpace(promptTemplate)
	replacements := map[string]string{
		"{{bot_name}}":     cfg.BotPublicName,
		"{{current_time}}": time.Now().Format(time.RFC3339),
	}
	for placeholder, value := range replacements {
		prompt = strings.ReplaceAll(prompt, placeholder, value)
	}

	parts := []string{prompt}

	for _, skill := range skills {
		parts = append(parts, fmt.Sprintf("## Skill: %s\n\n%s", skill.Name, strings.TrimSpace(skill.Body)))
	}
	return strings.Join(parts, "\n\n")
}
