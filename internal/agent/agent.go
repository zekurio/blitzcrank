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

const toolResultMessageLimit = 24000

type Agent struct {
	cfg                  config.Config
	client               llm.Client
	registry             *tools.Registry
	system               string
	skills               []Skill
	runtimePrompt        string
	discordTriagePrompt  string
	discordSummaryPrompt string
}

type Request struct {
	Source    string
	Author    string
	Content   string
	ToolAudit func(ToolAuditRecord)
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
	system := BuildSystemPrompt(cfg, prompt, nil)
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
		skills:               skills,
		runtimePrompt:        runtimePrompt,
		discordTriagePrompt:  discordTriagePrompt,
		discordSummaryPrompt: discordSummaryPrompt,
	}, nil
}

func (a *Agent) Respond(ctx context.Context, req Request) (string, error) {
	model := a.ModelName(req)
	reasoningEffort := a.ReasoningEffort(req, model)
	toolPolicy := a.toolPolicy(req)
	messages := []llm.Message{
		{Role: "system", Content: a.systemPrompt(req)},
		{Role: "system", Content: a.workflowPrompt(req, toolPolicy)},
		{Role: "system", Content: a.runtimeMetadata(model, reasoningEffort)},
		{Role: "user", Content: fmt.Sprintf("Source: %s\nAuthor: %s\n\n%s", req.Source, req.Author, req.Content)},
	}

	for range a.cfg.MaxToolIterations {
		response, err := a.client.Chat(ctx, llm.ChatRequest{
			Model:           model,
			ReasoningEffort: reasoningEffort,
			Messages:        messages,
			Tools:           a.registry.OpenAIToolsForPolicy(toolPolicy),
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
	if err := validateDiscordTriageResult(result); err != nil {
		return DiscordTriageResult{}, err
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
		"current_time":     time.Now().Format(time.RFC3339),
	})
}

func (a *Agent) executeTool(ctx context.Context, req Request, call llm.ToolCall, policy tools.ToolPolicy) (any, error) {
	if policy.ReadOnly && a.registry.IsMutatingTool(call.Function.Name) {
		return nil, fmt.Errorf("tool %s is not permitted in read-only source policy", call.Function.Name)
	}
	if !a.registry.ToolAllowedForPolicy(call.Function.Name, policy) {
		return nil, fmt.Errorf("tool %s is not available for selected capability set", call.Function.Name)
	}
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
	completedAt := time.Now()
	if req.ToolAudit != nil {
		record := ToolAuditRecord{
			Name:             call.Function.Name,
			Mutating:         a.registry.IsMutatingTool(call.Function.Name),
			ArgumentsSummary: compactLogValue(args, 2000),
			StartedAt:        start.UTC(),
			CompletedAt:      completedAt.UTC(),
		}
		if err != nil {
			record.Error = compactToolError(call.Function.Name, err.Error())
		} else {
			record.ResultSummary = compactLogValue(result, 4000)
		}
		req.ToolAudit(record)
	}
	elapsed := completedAt.Sub(start).Round(time.Millisecond)
	if err != nil {
		log.Printf("agent tool call failed: name=%s duration=%s error=%q", call.Function.Name, elapsed, compactLogString(err.Error(), 1024))
		return nil, err
	}
	log.Printf("agent tool call succeeded: name=%s duration=%s result=%s", call.Function.Name, elapsed, compactLogValue(result, 1024))
	return result, nil
}

func (a *Agent) toolPolicy(req Request) tools.ToolPolicy {
	source := strings.ToLower(strings.TrimSpace(req.Source))
	groups := a.toolGroupsForRequest(req)
	switch {
	case strings.HasPrefix(source, "jellyseerr_issue_"):
		return tools.ToolPolicy{Groups: groups}
	default:
		return tools.ToolPolicy{ReadOnly: true, Groups: groups}
	}
}

func (a *Agent) systemPrompt(req Request) string {
	skills := a.skillsForRequest(req)
	if len(skills) == 0 {
		return a.system
	}
	parts := []string{a.system}
	for _, skill := range skills {
		parts = append(parts, formatSkillPrompt(skill))
	}
	return strings.Join(parts, "\n\n")
}

func (a *Agent) skillsForRequest(req Request) []Skill {
	selected := skillNamesForGroups(a.toolGroupsForRequest(req))
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(req.Source)), "jellyseerr_issue_") {
		selected = append([]string{"seerr-issue-solver"}, selected...)
	}
	selectedSet := map[string]bool{}
	for _, name := range selected {
		selectedSet[name] = true
	}
	var out []Skill
	for _, skill := range a.skills {
		if selectedSet[skill.Name] {
			out = append(out, skill)
		}
	}
	return out
}

func skillNamesForGroups(groups []string) []string {
	var names []string
	for _, group := range groups {
		switch group {
		case "jellyseerr", "jellyfin", "sonarr", "radarr", "sabnzbd", "filesystem":
			names = append(names, group)
		}
	}
	return uniqueStrings(names)
}

func (a *Agent) toolGroupsForRequest(req Request) []string {
	source := strings.ToLower(strings.TrimSpace(req.Source))
	if strings.HasPrefix(source, "jellyseerr_issue_") {
		return []string{"jellyseerr", "jellyfin", "sonarr", "radarr", "sabnzbd", "filesystem", "web"}
	}
	if source == "automation_cron" {
		return []string{"jellyseerr", "jellyfin", "sonarr", "radarr", "sabnzbd", "filesystem", "web"}
	}

	text := normalizedCapabilityText(req.Content)
	var groups []string
	addGroup := func(name string) {
		groups = append(groups, name)
	}
	if containsAny(text, "jellyseerr", "overseerr", "seerr", "request", "issue") {
		addGroup("jellyseerr")
	}
	if containsAny(text, "jellyfin", "library", "libraries", "playback", "watched", "played", "user", "users", "view", "views", "subtitle", "subtitles", "untertitel", "audio", "tonspur", "verfuegbar", "available") {
		addGroup("jellyfin")
	}
	if containsAny(text, "sonarr", "series", "season", "episode", "tvdb", "serie", "staffel", "folge", "s0") {
		addGroup("sonarr")
	}
	if containsAny(text, "radarr", "movie", "film", "tmdb") {
		addGroup("radarr")
	}
	if containsAny(text, "sabnzbd", "sab", "download", "queue", "blocklist", "import", "stuck", "failed", "haengt", "fehler") {
		addGroup("sabnzbd")
	}
	if containsAny(text, "disk", "filesystem", "file", "path", "permissions", "folder", "directory", "speicher", "datei", "ordner", "import", "completed") {
		addGroup("filesystem")
	}
	if containsAny(text, "release", "released", "streaming", "public", "availability", "available", "verfuegbar", "wann", "when", "raus", "erscheint", "premiere", "anime") {
		addGroup("web")
	}
	if len(groups) == 0 && strings.HasPrefix(source, "discord") {
		return []string{"jellyseerr", "jellyfin", "web"}
	}
	return uniqueStrings(groups)
}

func normalizedCapabilityText(content string) string {
	text := strings.ToLower(strings.TrimSpace(content))
	text = strings.NewReplacer("ä", "ae", "ö", "oe", "ü", "ue", "ß", "ss").Replace(text)
	return strings.Join(strings.Fields(text), " ")
}

func containsAny(text string, needles ...string) bool {
	for _, needle := range needles {
		if strings.Contains(text, needle) {
			return true
		}
	}
	return false
}

func uniqueStrings(values []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func (a *Agent) workflowPrompt(req Request, policy tools.ToolPolicy) string {
	source := strings.ToLower(strings.TrimSpace(req.Source))
	mutation := "Mutating tools are available only when the active workflow and evidence allow them."
	if policy.ReadOnly {
		mutation = "This run is read-only: use lookup/search tools only, do not attempt repairs, refreshes, retries, searches that alter queues, deletes, or issue resolution."
	}
	switch {
	case strings.HasPrefix(source, "jellyseerr_issue_"):
		return "Active workflow: Jellyseerr issue. Follow the Jellyseerr issue workflow and final-comment rules. " + mutation
	case source == "automation_cron":
		return "Active workflow: scheduled automation. Follow the automation prompt for output shape. Ignore Jellyseerr issue final-comment rules unless the automation explicitly concerns a Jellyseerr issue. " + mutation
	case strings.HasPrefix(source, "discord"):
		return "Active workflow: Discord support. Reply as a Discord message. Ignore Jellyseerr issue final-comment rules unless the user explicitly asks about a Jellyseerr issue. " + mutation
	default:
		return "Active workflow: general media-server support. Ignore Jellyseerr issue final-comment rules unless the request explicitly concerns a Jellyseerr issue. " + mutation
	}
}

func validateDiscordTriageResult(result DiscordTriageResult) error {
	action := strings.TrimSpace(result.Action)
	switch action {
	case "ignore", "direct_reply", "support_request", "unsupported", "clarify":
	default:
		return fmt.Errorf("discord triage returned invalid action %q", result.Action)
	}
	if result.Confidence < 0 || result.Confidence > 1 {
		return fmt.Errorf("discord triage returned confidence %.2f outside [0,1]", result.Confidence)
	}
	if action == "support_request" && (!result.Actionable || !result.NeedsAgentRun) {
		return fmt.Errorf("discord triage support_request must be actionable and need an agent run")
	}
	if action == "ignore" && (result.Actionable || result.NeedsAgentRun) {
		return fmt.Errorf("discord triage ignore must not be actionable or need an agent run")
	}
	return nil
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

func toolResultMessagePayload(result any, limit int) string {
	payload, err := json.Marshal(result)
	if err != nil {
		payload, _ = json.Marshal(map[string]any{
			"ok":    false,
			"error": compactToolError("tool_result", err.Error()),
		})
	}
	if limit <= 0 || len(payload) <= limit {
		return string(payload)
	}
	preview := truncateRunes(string(payload), limit)
	wrapped, err := json.Marshal(map[string]any{
		"ok":              true,
		"truncated":       true,
		"original_bytes":  len(payload),
		"retained_chars":  len([]rune(preview)),
		"result_preview":  preview,
		"compaction_note": "Tool result exceeded the harness context budget; use the preview only and call a narrower tool/query if more detail is needed.",
	})
	if err != nil {
		return `{"ok":false,"error":"tool result exceeded context budget and could not be compacted"}`
	}
	return string(wrapped)
}

func truncateRunes(value string, limit int) string {
	if limit <= 0 {
		return strings.TrimSpace(value)
	}
	runes := []rune(strings.TrimSpace(value))
	if len(runes) <= limit {
		return string(runes)
	}
	return string(runes[:limit]) + "... [truncated]"
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

func (a *Agent) ToolNames(req Request) []string {
	return a.registry.ToolNamesForPolicy(a.toolPolicy(req))
}

func (a *Agent) MutatingToolNames() []string {
	readOnly := map[string]bool{}
	for _, name := range a.registry.ToolNamesForPolicy(tools.ToolPolicy{ReadOnly: true}) {
		readOnly[name] = true
	}
	var names []string
	for _, name := range a.registry.ToolNamesForPolicy(tools.ToolPolicy{}) {
		if !readOnly[name] {
			names = append(names, name)
		}
	}
	return names
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
		parts = append(parts, formatSkillPrompt(skill))
	}
	return strings.Join(parts, "\n\n")
}

func formatSkillPrompt(skill Skill) string {
	return fmt.Sprintf("## Skill: %s\n\nDescription: %s\n\n%s", skill.Name, strings.TrimSpace(skill.Description), strings.TrimSpace(skill.Body))
}
