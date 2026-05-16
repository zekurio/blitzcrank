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
	cfg                  config.Config
	client               llm.Client
	registry             *tools.Registry
	system               string
	runtimePrompt        string
	discordTriagePrompt  string
	discordSummaryPrompt string
}

type Request struct {
	Source  string
	Author  string
	Content string
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
	runtimePrompt, err := LoadPromptTemplate(cfg.RuntimePromptPath)
	if err != nil {
		return nil, err
	}
	discordTriagePrompt, err := LoadPromptTemplate(cfg.DiscordTriagePromptPath)
	if err != nil {
		return nil, err
	}
	discordSummaryPrompt, err := LoadPromptTemplate(cfg.DiscordSummaryPromptPath)
	if err != nil {
		return nil, err
	}
	client, err := llm.New(cfg)
	if err != nil {
		return nil, err
	}
	return &Agent{
		cfg:                  cfg,
		client:               client,
		registry:             registry,
		system:               system,
		runtimePrompt:        runtimePrompt,
		discordTriagePrompt:  discordTriagePrompt,
		discordSummaryPrompt: discordSummaryPrompt,
	}, nil
}

func (a *Agent) Respond(ctx context.Context, req Request) (string, error) {
	model := a.ModelName(req)
	reasoningEffort := a.ReasoningEffort(req, model)
	messages := []llm.Message{
		{Role: "system", Content: a.system},
		{Role: "system", Content: a.runtimeMetadata(model, reasoningEffort)},
		{Role: "user", Content: fmt.Sprintf("Source: %s\nAuthor: %s\n\n%s", req.Source, req.Author, req.Content)},
	}

	for range a.cfg.MaxToolIterations {
		response, err := a.client.Chat(ctx, llm.ChatRequest{
			Model:           model,
			ReasoningEffort: reasoningEffort,
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
				result = toolErrorResult(call.Function.Name, err)
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

func (a *Agent) TriageDiscordMessage(ctx context.Context, req DiscordTriageRequest) (DiscordTriageResult, error) {
	response, err := a.client.Chat(ctx, llm.ChatRequest{
		Model:           a.discordTriageModel(),
		ReasoningEffort: a.discordTriageReasoningEffort(),
		Messages: []llm.Message{
			{Role: "system", Content: a.discordTriagePrompt},
			{Role: "user", Content: fmt.Sprintf("Author: %s\nMentioned bot: %t\nMessage:\n%s", req.Author, req.Mention, req.Content)},
		},
	})
	if err != nil {
		return DiscordTriageResult{}, err
	}
	var result DiscordTriageResult
	if err := json.Unmarshal([]byte(extractJSONObject(response.FirstChoice().Message.Content)), &result); err != nil {
		return DiscordTriageResult{}, fmt.Errorf("parse discord triage JSON: %w", err)
	}
	return result, nil
}

func (a *Agent) SummarizeDiscordThread(ctx context.Context, previousSummary, latestUserMessage, assistantReply string) (string, error) {
	response, err := a.client.Chat(ctx, llm.ChatRequest{
		Model:           a.discordTriageModel(),
		ReasoningEffort: a.discordTriageReasoningEffort(),
		Messages: []llm.Message{
			{Role: "system", Content: a.discordSummaryPrompt},
			{Role: "user", Content: fmt.Sprintf("Previous summary:\n%s\n\nLatest user message:\n%s\n\nAssistant reply:\n%s", previousSummary, latestUserMessage, assistantReply)},
		},
	})
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(response.FirstChoice().Message.Content), nil
}

func (a *Agent) discordTriageModel() string {
	return strings.TrimSpace(a.cfg.DiscordTriageModel)
}

func (a *Agent) discordTriageReasoningEffort() string {
	return strings.TrimSpace(a.cfg.DiscordTriageReasoningEffort)
}

func (a *Agent) runtimeMetadata(model, reasoningEffort string) string {
	if strings.TrimSpace(reasoningEffort) == "" {
		reasoningEffort = "unspecified"
	}
	return renderPrompt(a.runtimePrompt, map[string]string{
		"model":            strings.TrimSpace(model),
		"reasoning_effort": strings.TrimSpace(reasoningEffort),
	})
}

func (a *Agent) executeTool(ctx context.Context, call llm.ToolCall) (any, error) {
	var args map[string]any
	if call.Function.Arguments != "" {
		if err := json.Unmarshal([]byte(call.Function.Arguments), &args); err != nil {
			log.Printf("agent tool call failed: name=%s parse_args=true arguments=%s error=%q", call.Function.Name, compactLogString(call.Function.Arguments, 512), err.Error())
			return nil, fmt.Errorf("parse tool arguments for %s: %w", call.Function.Name, err)
		}
	}
	if args == nil {
		args = map[string]any{}
	}
	log.Printf("agent tool call start: name=%s args=%s", call.Function.Name, compactLogValue(args, 512))
	start := time.Now()
	result, err := a.registry.Call(ctx, call.Function.Name, args)
	elapsed := time.Since(start).Round(time.Millisecond)
	if err != nil {
		log.Printf("agent tool call failed: name=%s duration=%s error=%q", call.Function.Name, elapsed, compactLogString(err.Error(), 1024))
		return nil, err
	}
	log.Printf("agent tool call succeeded: name=%s duration=%s result=%s", call.Function.Name, elapsed, compactLogValue(result, 1024))
	return result, nil
}

func extractJSONObject(content string) string {
	content = strings.TrimSpace(content)
	start := strings.Index(content, "{")
	end := strings.LastIndex(content, "}")
	if start >= 0 && end >= start {
		return content[start : end+1]
	}
	return content
}

func renderPrompt(template string, values map[string]string) string {
	out := strings.TrimSpace(template)
	for key, value := range values {
		out = strings.ReplaceAll(out, "{{"+key+"}}", value)
	}
	return out
}

func compactLogValue(value any, limit int) string {
	data, err := json.Marshal(value)
	if err != nil {
		return compactLogString(fmt.Sprintf("%v", value), limit)
	}
	return compactLogString(string(data), limit)
}

func compactLogString(value string, limit int) string {
	value = strings.TrimSpace(value)
	if limit > 0 && len(value) > limit {
		return value[:limit] + "..."
	}
	return value
}

func toolErrorResult(name string, err error) map[string]any {
	message := strings.TrimSpace(err.Error())
	out := map[string]any{
		"ok":    false,
		"tool":  name,
		"error": compactToolError(name, message),
	}
	if category := toolErrorCategory(message); category != "" {
		out["category"] = category
	}
	return out
}

func compactToolError(name, message string) string {
	if len(message) > 240 {
		return message[:240] + "..."
	}
	return message
}

func toolErrorCategory(message string) string {
	lower := strings.ToLower(message)
	switch {
	case strings.Contains(lower, "not configured"):
		return "not_configured"
	case strings.Contains(lower, "unauthorized") || strings.Contains(lower, "401"):
		return "unauthorized"
	case strings.Contains(lower, "rate") || strings.Contains(lower, "429"):
		return "rate_limited"
	default:
		return ""
	}
}

func (a *Agent) ModelName(req Request) string {
	return strings.TrimSpace(a.cfg.Model)
}

func (a *Agent) ReasoningEffort(_ Request, model string) string {
	return ReasoningEffortForRequest(a.cfg.ReasoningEffort, model)
}

func (a *Agent) RuntimeInfo(req Request) (string, string) {
	model := a.ModelName(req)
	return model, a.ReasoningEffort(req, model)
}

func ReasoningEffortForRequest(fallback, model string) string {
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
		parts = append(parts, fmt.Sprintf("## Skill: %s\n\nDescription: %s\n\n%s", skill.Name, strings.TrimSpace(skill.Description), strings.TrimSpace(skill.Body)))
	}
	return strings.Join(parts, "\n\n")
}
