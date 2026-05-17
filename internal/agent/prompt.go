package agent

import (
	"fmt"
	"strings"
	"time"

	assets "blitzcrank"
	"blitzcrank/internal/config"
	"blitzcrank/internal/tools"
)

const (
	systemPromptPath         = "prompts/system.md"
	runtimePromptPath        = "prompts/runtime-metadata.md"
	discordTriagePromptPath  = "prompts/discord-triage.md"
	discordSummaryPromptPath = "prompts/discord-thread-summary.md"
)

func (a *Agent) loadPromptsAndSkills() error {
	skills, err := LoadRuntimeSkills(a.cfg)
	if err != nil {
		return err
	}
	prompt, err := LoadPromptTemplate(systemPromptPath)
	if err != nil {
		return err
	}
	system := BuildSystemPrompt(a.cfg, prompt, nil)
	runtimePrompt, err := LoadPromptTemplate(runtimePromptPath)
	if err != nil {
		return err
	}
	discordTriagePrompt, err := LoadPromptTemplate(discordTriagePromptPath)
	if err != nil {
		return err
	}
	discordSummaryPrompt, err := LoadPromptTemplate(discordSummaryPromptPath)
	if err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.system = system
	a.skills = skills
	a.runtimePrompt = runtimePrompt
	a.discordTriagePrompt = discordTriagePrompt
	a.discordSummaryPrompt = discordSummaryPrompt
	return nil
}

func (a *Agent) runtimeMetadata(model, reasoningEffort string, policy tools.ToolPolicy) string {
	if strings.TrimSpace(reasoningEffort) == "" {
		reasoningEffort = "unspecified"
	}
	a.mu.RLock()
	prompt := a.runtimePrompt
	a.mu.RUnlock()
	return renderPrompt(prompt, map[string]string{
		"model":            strings.TrimSpace(model),
		"reasoning_effort": strings.TrimSpace(reasoningEffort),
		"current_time":     time.Now().Format(time.RFC3339),
		"callable_tools":   metadataList(a.registry.ToolNamesForPolicy(policy)),
		"mutating_tools":   metadataList(a.MutatingToolNames()),
		"read_only":        fmt.Sprintf("%t", policy.ReadOnly),
		"automations":      a.automationRuntimeMetadata(),
	})
}

func (a *Agent) automationRuntimeMetadata() string {
	if a.automationMetadata == nil {
		return "unavailable"
	}
	metadata := a.automationMetadata.AutomationRuntimeMetadata(time.Now())
	if !metadata.Enabled {
		return "disabled"
	}
	timezone := strings.TrimSpace(metadata.Timezone)
	if timezone == "" {
		timezone = "UTC"
	}
	if strings.TrimSpace(metadata.Error) != "" {
		return fmt.Sprintf("enabled; timezone=%s; error=%s", timezone, compactLogString(metadata.Error, 240))
	}
	if len(metadata.Tasks) == 0 {
		return fmt.Sprintf("enabled; timezone=%s; tasks=none", timezone)
	}
	parts := make([]string, 0, len(metadata.Tasks))
	for _, task := range metadata.Tasks {
		nextRun := "unknown"
		if !task.NextRun.IsZero() {
			nextRun = task.NextRun.Format(time.RFC3339)
		}
		description := strings.TrimSpace(task.Description)
		if description != "" {
			description = " description=" + compactLogString(description, 160)
		}
		parts = append(parts, fmt.Sprintf("%s schedule=%s next_run=%s%s", strings.TrimSpace(task.Name), strings.TrimSpace(task.Schedule), nextRun, description))
	}
	return fmt.Sprintf("enabled; timezone=%s; tasks=%s", timezone, strings.Join(parts, " | "))
}

func metadataList(values []string) string {
	var cleaned []string
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			cleaned = append(cleaned, value)
		}
	}
	if len(cleaned) == 0 {
		return "none"
	}
	return strings.Join(cleaned, ", ")
}

func (a *Agent) systemPrompt(req Request) string {
	a.mu.RLock()
	system := a.system
	skills := append([]Skill(nil), a.skills...)
	a.mu.RUnlock()
	skills = skillsForRequest(req, skills, a.toolGroupsForRequest(req))
	if len(skills) == 0 {
		return system
	}
	parts := []string{system}
	for _, skill := range skills {
		parts = append(parts, formatSkillPrompt(skill))
	}
	return strings.Join(parts, "\n\n")
}

func renderPrompt(template string, values map[string]string) string {
	out := strings.TrimSpace(template)
	for key, value := range values {
		out = strings.ReplaceAll(out, "{{"+key+"}}", value)
	}
	return out
}

func LoadSystemPrompt(cfg config.Config) (string, error) {
	prompt, err := LoadPromptTemplate(systemPromptPath)
	if err != nil {
		return "", err
	}
	return BuildSystemPrompt(cfg, prompt, nil), nil
}

func LoadPromptTemplate(path string) (string, error) {
	content, err := assets.FS.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("load embedded prompt %s: %w", path, err)
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
	if strings.TrimSpace(skill.Prompt) != "" {
		return strings.TrimSpace(skill.Prompt)
	}
	return fmt.Sprintf("## Skill: %s\n\nDescription: %s\n\n%s", skill.Name, strings.TrimSpace(skill.Description), strings.TrimSpace(skill.Body))
}
