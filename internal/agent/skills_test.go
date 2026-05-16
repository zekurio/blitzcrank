package agent

import (
	"blitzcrank/internal/config"
	"blitzcrank/internal/llm"
	"blitzcrank/internal/tools"
	"bytes"
	"context"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadSkillsDeterministic(t *testing.T) {
	root := t.TempDir()
	writeSkill(t, root, "zeta", "zeta")
	writeSkill(t, root, "alpha", "alpha")

	skills, err := LoadSkills(root)
	if err != nil {
		t.Fatalf("LoadSkills() error = %v", err)
	}
	if len(skills) != 2 {
		t.Fatalf("LoadSkills() len = %d, want 2", len(skills))
	}
	if skills[0].Name != "alpha" || skills[1].Name != "zeta" {
		t.Fatalf("skills loaded out of order: %#v", skills)
	}
}

func TestLoadSkillsRequiresFrontmatter(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "broken")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("# Missing frontmatter"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := LoadSkills(root); err == nil {
		t.Fatal("LoadSkills() error = nil, want frontmatter error")
	}
}

func TestLoadSkillsIgnoresRuntimeFrontmatter(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "alpha")
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
	content := "---\nname: alpha\ndescription: Test skill\nmodel: gpt-test\nreasoning_effort: high\n---\n\n# Skill\n"
	if err := os.WriteFile(filepath.Join(path, "SKILL.md"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	skills, err := LoadSkills(root)
	if err != nil {
		t.Fatalf("LoadSkills() error = %v", err)
	}
	if skills[0].Name != "alpha" || skills[0].Description != "Test skill" {
		t.Fatalf("skill = %#v, want parsed name and description", skills[0])
	}
}

func TestReasoningEffortForRequestUsesGlobalFallback(t *testing.T) {
	if got := ReasoningEffortForRequest("medium", "gpt-5.5"); got != "medium" {
		t.Fatalf("ReasoningEffortForRequest() = %q, want medium", got)
	}
}

func TestReasoningEffortForRequestUsesRecommendedModelDefault(t *testing.T) {
	tests := []struct {
		model string
		want  string
	}{
		{model: "gpt-5.4-mini", want: "high"},
		{model: "openai/gpt-5.4-mini", want: "high"},
		{model: "gpt-5.4", want: "medium"},
		{model: "openai/gpt-5.5:nitro", want: "low"},
		{model: "unknown-model", want: ""},
	}
	for _, tt := range tests {
		if got := ReasoningEffortForRequest("", tt.model); got != tt.want {
			t.Fatalf("ReasoningEffortForRequest(%q) = %q, want %q", tt.model, got, tt.want)
		}
	}
}

func TestRuntimeMetadataIncludesModel(t *testing.T) {
	agent := &Agent{runtimePrompt: `Trusted runtime metadata for this response: model={{model}}; reasoning_effort={{reasoning_effort}}.

If the user asks which model you are using, answer with both the model and reasoning effort from this metadata.`}
	metadata := agent.runtimeMetadata("gpt-5.4", "low")
	if !strings.Contains(metadata, "model=gpt-5.4") || !strings.Contains(metadata, "reasoning_effort=low") {
		t.Fatalf("runtimeMetadata() = %q", metadata)
	}
	if !strings.Contains(metadata, "both the model and reasoning effort") {
		t.Fatalf("runtimeMetadata() does not instruct model/reasoning answer: %q", metadata)
	}
}

func TestExecuteToolLogsFailureDetail(t *testing.T) {
	var logs bytes.Buffer
	previousWriter := log.Writer()
	previousFlags := log.Flags()
	log.SetOutput(&logs)
	log.SetFlags(0)
	defer func() {
		log.SetOutput(previousWriter)
		log.SetFlags(previousFlags)
	}()

	agent := &Agent{registry: tools.NewRegistry(config.Config{})}
	var call llm.ToolCall
	call.Function.Name = "fs_stat_path"
	call.Function.Arguments = `{"path":"/tmp"}`

	_, err := agent.executeTool(context.Background(), call)
	if err == nil {
		t.Fatal("executeTool() error = nil, want filesystem configuration error")
	}

	output := logs.String()
	for _, want := range []string{
		`agent tool call start: name=fs_stat_path args={"path":"/tmp"}`,
		`agent tool call failed: name=fs_stat_path`,
		`filesystem tools are not configured`,
	} {
		if !strings.Contains(output, want) {
			t.Fatalf("tool logs missing %q:\n%s", want, output)
		}
	}
}

func TestDiscordTriageConfigValuesAreUsedVerbatim(t *testing.T) {
	agent := &Agent{cfg: config.Config{
		DiscordTriageModel:           "gpt-5.4-mini",
		DiscordTriageReasoningEffort: "none",
	}}
	if got := agent.discordTriageModel(); got != "gpt-5.4-mini" {
		t.Fatalf("discordTriageModel() = %q, want gpt-5.4-mini", got)
	}
	if got := agent.discordTriageReasoningEffort(); got != "none" {
		t.Fatalf("discordTriageReasoningEffort() = %q, want none", got)
	}
}

func TestDiscordTriagePromptRequiresGermanThreadTitles(t *testing.T) {
	prompt, err := LoadPromptTemplate("../../prompts/discord-triage.md")
	if err != nil {
		t.Fatalf("LoadPromptTemplate() error = %v", err)
	}
	for _, want := range []string{
		"thread_title is user-facing Discord text",
		"default to German",
		"Preserve media titles",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("discord triage prompt missing %q:\n%s", want, prompt)
		}
	}
}

func TestRuntimeInfoReturnsModelAndReasoning(t *testing.T) {
	agent := &Agent{cfg: config.Config{Model: "gpt-5.5"}}
	model, effort := agent.RuntimeInfo(Request{Source: "discord_mention"})
	if model != "gpt-5.5" || effort != "low" {
		t.Fatalf("RuntimeInfo() = (%q, %q), want (gpt-5.5, low)", model, effort)
	}
}

func TestBuildSystemPromptIsMarkdown(t *testing.T) {
	template := "# {{bot_name}} System Prompt\n\n## Role\n\nCurrent time: {{current_time}}.\n\n## Operating Principles\n\n## Jellyseerr Issue Workflow\n\nFor explicit diagnostic or test instructions.\n"
	prompt := BuildSystemPrompt(configForTest(), template, []Skill{{Name: "alpha", Body: "# Alpha\n\nUse alpha."}})
	for _, want := range []string{
		"# Blitzcrank System Prompt",
		"## Role",
		"## Operating Principles",
		"## Jellyseerr Issue Workflow",
		"## Skill: alpha",
		"Description:",
		"For explicit diagnostic or test instructions",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("system prompt missing %q:\n%s", want, prompt)
		}
	}
}

func TestLoadPromptTemplate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "system.md")
	if err := os.WriteFile(path, []byte("# Prompt\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	prompt, err := LoadPromptTemplate(path)
	if err != nil {
		t.Fatalf("LoadPromptTemplate() error = %v", err)
	}
	if prompt != "# Prompt" {
		t.Fatalf("prompt = %q, want # Prompt", prompt)
	}
}

func writeSkill(t *testing.T, root, dir, name string) {
	t.Helper()
	path := filepath.Join(root, dir)
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
	content := "---\nname: " + name + "\ndescription: Test skill\n---\n\n# Skill\n"
	if err := os.WriteFile(filepath.Join(path, "SKILL.md"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func configForTest() config.Config {
	return config.Config{BotPublicName: "Blitzcrank"}
}
