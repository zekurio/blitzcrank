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
	"time"
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

func TestLoadEmbeddedSkills(t *testing.T) {
	skills, err := LoadEmbeddedSkills()
	if err != nil {
		t.Fatalf("LoadEmbeddedSkills() error = %v", err)
	}
	if !skillSliceContains(skills, "jellyfin") || !skillSliceContains(skills, "seerr-issue-solver") {
		t.Fatalf("embedded skills missing expected entries: %#v", skills)
	}
}

func TestLoadPromptTemplateReadsEmbeddedPrompt(t *testing.T) {
	prompt, err := LoadPromptTemplate(systemPromptPath)
	if err != nil {
		t.Fatalf("LoadPromptTemplate() error = %v", err)
	}
	if !strings.Contains(prompt, "{{bot_name}} System Prompt") {
		t.Fatalf("embedded prompt = %q, want system prompt", prompt)
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
	if policy := agent.toolPolicy(Request{Source: "automation_cron", Content: "Run the hourly stale import handler."}); policy.ReadOnly {
		t.Fatal("stale import handler policy is read-only")
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

func TestToolPolicyKeepsWebCapabilityInContext(t *testing.T) {
	agent := &Agent{}
	policy := agent.toolPolicy(Request{Source: "discord_thread", Content: "download queue is stuck"})
	if !stringSliceContains(policy.Groups, "sabnzbd") {
		t.Fatalf("groups = %#v, want sabnzbd", policy.Groups)
	}
	if !stringSliceContains(policy.Groups, "web") {
		t.Fatalf("groups = %#v, want web always selected", policy.Groups)
	}
}

func TestToolPolicySplitsSabnzbdAndFilesystemGroups(t *testing.T) {
	agent := &Agent{}
	sab := agent.toolPolicy(Request{Source: "discord_thread", Content: "download queue is stuck"})
	if !stringSliceContains(sab.Groups, "sabnzbd") || !stringSliceContains(sab.Groups, "web") || stringSliceContains(sab.Groups, "filesystem") {
		t.Fatalf("download groups = %#v, want sabnzbd and web only", sab.Groups)
	}
	fs := agent.toolPolicy(Request{Source: "discord_thread", Content: "check disk space and file permissions"})
	if !stringSliceContains(fs.Groups, "filesystem") || !stringSliceContains(fs.Groups, "web") || stringSliceContains(fs.Groups, "sabnzbd") {
		t.Fatalf("filesystem groups = %#v, want filesystem and web only", fs.Groups)
	}
}

func TestToolContextPromptBalancesAwarenessAndUse(t *testing.T) {
	agent := &Agent{registry: tools.NewRegistry(config.Config{ExaAPIKey: "secret"})}
	prompt := agent.toolContextPrompt(tools.ToolPolicy{ReadOnly: true, Groups: []string{"jellyfin", "web"}})
	for _, want := range []string{
		"Selected tools by capability: jellyfin (",
		"web (web_search)",
		"not a checklist",
		"read-only",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("toolContextPrompt() missing %q:\n%s", want, prompt)
		}
	}
}

func TestRespondPropagatesSelectedToolsAcrossIterations(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "file.txt")
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	toolCall := llm.ToolCall{ID: "call_1", Type: "function"}
	toolCall.Function.Name = "fs_stat_path"
	toolCall.Function.Arguments = `{"path":"` + path + `"}`
	client := &recordingClient{responses: []llm.ChatResponse{
		responseWithMessage(llm.Message{Role: "assistant", ToolCalls: []llm.ToolCall{toolCall}}),
		responseWithMessage(llm.Message{Role: "assistant", Content: "done"}),
	}}
	agent := &Agent{
		cfg:           config.Config{Model: "gpt-test", MaxToolIterations: 2},
		client:        client,
		registry:      tools.NewRegistry(config.Config{FSAllowedRoots: []string{root}, ExaAPIKey: "secret"}),
		system:        "system",
		runtimePrompt: "model={{model}}; reasoning_effort={{reasoning_effort}}; callable={{callable_tools}}; read_only={{read_only}}",
	}

	reply, err := agent.Respond(context.Background(), Request{Source: "discord_thread", Content: "check file permissions"})
	if err != nil {
		t.Fatalf("Respond() error = %v", err)
	}
	if reply != "done" {
		t.Fatalf("reply = %q, want done", reply)
	}
	if len(client.requests) != 2 {
		t.Fatalf("chat requests = %d, want 2", len(client.requests))
	}
	for i, request := range client.requests {
		names := toolNamesFromRaw(request.Tools)
		if !stringSliceContains(names, "fs_stat_path") || !stringSliceContains(names, "web_search") {
			t.Fatalf("request %d tools = %#v, want filesystem and web tools", i, names)
		}
	}
	if len(client.requests[1].Messages) == 0 || client.requests[1].Messages[len(client.requests[1].Messages)-1].Role != "tool" {
		t.Fatalf("second request did not propagate tool result messages: %#v", client.requests[1].Messages)
	}
	runtimeMessage := client.requests[0].Messages[3].Content
	if !strings.Contains(runtimeMessage, "callable=") || !strings.Contains(runtimeMessage, "fs_stat_path") || !strings.Contains(runtimeMessage, "read_only=true") {
		t.Fatalf("runtime metadata missing selected tool inventory: %q", runtimeMessage)
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

func TestRuntimeMetadataIncludesAutomationSchedule(t *testing.T) {
	agent := &Agent{
		cfg:                config.Config{Model: "gpt-test"},
		registry:           tools.NewRegistry(config.Config{}),
		runtimePrompt:      "automations={{automations}}",
		automationMetadata: fakeAutomationMetadata{},
	}
	metadata := agent.runtimeMetadata("gpt-test", "low", tools.ToolPolicy{ReadOnly: true})
	for _, want := range []string{"hourly-stale-import-handler", "cron: 0 * * * *", "2026-05-16T09:00:00Z"} {
		if !strings.Contains(metadata, want) {
			t.Fatalf("runtime metadata missing %q: %q", want, metadata)
		}
	}
}

type fakeAutomationMetadata struct{}

func (fakeAutomationMetadata) AutomationRuntimeMetadata(time.Time) AutomationRuntimeMetadata {
	return AutomationRuntimeMetadata{
		Enabled:  true,
		Timezone: "UTC",
		Tasks: []AutomationTaskMetadata{{
			Name:        "hourly-stale-import-handler",
			Description: "Handle stale imports",
			Schedule:    "cron: 0 * * * *",
			NextRun:     time.Date(2026, 5, 16, 9, 0, 0, 0, time.UTC),
		}},
	}
}

type recordingClient struct {
	requests  []llm.ChatRequest
	responses []llm.ChatResponse
}

func (c *recordingClient) Chat(_ context.Context, request llm.ChatRequest) (llm.ChatResponse, error) {
	c.requests = append(c.requests, request)
	response := c.responses[0]
	c.responses = c.responses[1:]
	return response, nil
}

func responseWithMessage(message llm.Message) llm.ChatResponse {
	var response llm.ChatResponse
	response.Choices = append(response.Choices, struct {
		Message llm.Message `json:"message"`
	}{Message: message})
	return response
}

func toolNamesFromRaw(rawTools []any) []string {
	var names []string
	for _, raw := range rawTools {
		tool := raw.(map[string]any)
		function := tool["function"].(map[string]any)
		names = append(names, function["name"].(string))
	}
	return names
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

func stringSliceContains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func skillSliceContains(values []Skill, want string) bool {
	for _, value := range values {
		if value.Name == want {
			return true
		}
	}
	return false
}
