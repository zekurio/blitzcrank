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
	agent := &Agent{runtimePrompt: `model={{model}}; reasoning_effort={{reasoning_effort}}`}
	metadata := agent.runtimeMetadata("gpt-5.4", "low")
	if metadata != "model=gpt-5.4; reasoning_effort=low" {
		t.Fatalf("runtimeMetadata() = %q", metadata)
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

	_, err := agent.executeTool(context.Background(), Request{}, call, tools.ToolPolicy{})
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

func TestExecuteToolEmitsAuditRecord(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "file.txt")
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	agent := &Agent{registry: tools.NewRegistry(config.Config{FSAllowedRoots: []string{root}})}
	var records []ToolAuditRecord
	var call llm.ToolCall
	call.Function.Name = "fs_stat_path"
	call.Function.Arguments = `{"path":"` + path + `"}`

	_, err := agent.executeTool(context.Background(), Request{ToolAudit: func(record ToolAuditRecord) {
		records = append(records, record)
	}}, call, tools.ToolPolicy{})
	if err != nil {
		t.Fatalf("executeTool() error = %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("audit records = %d, want 1", len(records))
	}
	if records[0].Name != "fs_stat_path" || records[0].ArgumentsSummary == "" || records[0].ResultSummary == "" || records[0].CompletedAt.Before(records[0].StartedAt) {
		t.Fatalf("audit record = %#v", records[0])
	}
}

func TestToolResultMessagePayloadCompactsLargeResults(t *testing.T) {
	result := map[string]any{"items": strings.Repeat("x", 200)}
	payload := toolResultMessagePayload(result, 80)

	for _, want := range []string{
		`"truncated":true`,
		`"original_bytes"`,
		`"result_preview"`,
		`[truncated]`,
	} {
		if !strings.Contains(payload, want) {
			t.Fatalf("payload missing %q: %s", want, payload)
		}
	}
}

func TestReadOnlyPolicyBlocksMutatingTools(t *testing.T) {
	agent := &Agent{registry: tools.NewRegistry(config.Config{})}
	var call llm.ToolCall
	call.Function.Name = "sonarr_search_episode"
	call.Function.Arguments = `{"episode_id":"42"}`

	_, err := agent.executeTool(context.Background(), Request{}, call, tools.ToolPolicy{ReadOnly: true})
	if err == nil || !strings.Contains(err.Error(), "not permitted") {
		t.Fatalf("executeTool() error = %v, want read-only policy error", err)
	}
}

func TestToolPolicyIsReadOnlyOutsideJellyseerrIssues(t *testing.T) {
	agent := &Agent{}
	if policy := agent.toolPolicy(Request{Source: "discord_thread"}); !policy.ReadOnly {
		t.Fatal("discord thread policy is not read-only")
	}
	if policy := agent.toolPolicy(Request{Source: "automation_cron"}); !policy.ReadOnly {
		t.Fatal("automation policy is not read-only")
	}
	if policy := agent.toolPolicy(Request{Source: "jellyseerr_issue_created"}); policy.ReadOnly {
		t.Fatal("jellyseerr issue policy is read-only")
	}
}

func TestToolPolicySelectsRelevantDiscordGroups(t *testing.T) {
	agent := &Agent{}
	policy := agent.toolPolicy(Request{Source: "discord_mention", Content: "Ist Project Hail Mary auf Jellyfin verfuegbar?"})
	if !policy.ReadOnly {
		t.Fatal("discord policy is not read-only")
	}
	if !stringSliceContains(policy.Groups, "jellyfin") || !stringSliceContains(policy.Groups, "web") {
		t.Fatalf("groups = %#v, want jellyfin and web", policy.Groups)
	}
	if stringSliceContains(policy.Groups, "sonarr") || stringSliceContains(policy.Groups, "filesystem") {
		t.Fatalf("groups = %#v, want no unrelated tool packs", policy.Groups)
	}
}

func TestToolPolicySplitsSabnzbdAndFilesystemGroups(t *testing.T) {
	agent := &Agent{}
	sab := agent.toolPolicy(Request{Source: "discord_thread", Content: "download queue is stuck"})
	if !stringSliceContains(sab.Groups, "sabnzbd") || stringSliceContains(sab.Groups, "filesystem") {
		t.Fatalf("download groups = %#v, want sabnzbd only", sab.Groups)
	}
	fs := agent.toolPolicy(Request{Source: "discord_thread", Content: "check disk space and file permissions"})
	if !stringSliceContains(fs.Groups, "filesystem") || stringSliceContains(fs.Groups, "sabnzbd") {
		t.Fatalf("filesystem groups = %#v, want filesystem only", fs.Groups)
	}
}

func TestSkillsForRequestLoadsOnlySelectedSkillPacks(t *testing.T) {
	agent := &Agent{skills: []Skill{
		{Name: "jellyfin"},
		{Name: "sonarr"},
		{Name: "filesystem"},
		{Name: "sabnzbd"},
	}}
	skills := agent.skillsForRequest(Request{Source: "discord_mention", Content: "Welche Jellyfin user haben Zugriff?"})
	if len(skills) != 1 || skills[0].Name != "jellyfin" {
		t.Fatalf("skills = %#v, want only jellyfin", skills)
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

func TestRuntimeInfoReturnsModelAndReasoning(t *testing.T) {
	agent := &Agent{cfg: config.Config{Model: "gpt-5.5"}}
	model, effort := agent.RuntimeInfo(Request{Source: "discord_mention"})
	if model != "gpt-5.5" || effort != "low" {
		t.Fatalf("RuntimeInfo() = (%q, %q), want (gpt-5.5, low)", model, effort)
	}
}

func TestBuildSystemPromptAppendsSkills(t *testing.T) {
	template := "# {{bot_name}} System Prompt"
	prompt := BuildSystemPrompt(configForTest(), template, []Skill{{Name: "alpha", Body: "# Alpha\n\nUse alpha."}})
	want := "# Blitzcrank System Prompt\n\n## Skill: alpha\n\nDescription: \n\n# Alpha\n\nUse alpha."
	if prompt != want {
		t.Fatalf("BuildSystemPrompt() = %q", prompt)
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

func stringSliceContains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
