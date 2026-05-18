package agent

import (
	"blitzcrank/internal/config"
	"blitzcrank/internal/llm"
	"blitzcrank/internal/tools"
	"bytes"
	"context"
	"encoding/json"
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
	if !strings.Contains(skills[0].Prompt, "## Skill: alpha") {
		t.Fatalf("skill prompt = %q, want preformatted prompt", skills[0].Prompt)
	}
}

func TestLoadSkillsRequiresNameToMatchDirectory(t *testing.T) {
	root := t.TempDir()
	writeSkill(t, root, "alpha", "beta")

	_, err := LoadSkills(root)
	if err == nil || !strings.Contains(err.Error(), "must match directory") {
		t.Fatalf("LoadSkills() error = %v, want directory/name mismatch", err)
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

func TestLoadRuntimeSkillsErrorsForExplicitEmptyDirectory(t *testing.T) {
	root := t.TempDir()
	_, err := LoadRuntimeSkills(config.Config{SkillsDirectory: root})
	if err == nil || !strings.Contains(err.Error(), "no skills found") {
		t.Fatalf("LoadRuntimeSkills() error = %v, want no skills found", err)
	}
}

func TestLoadRuntimeSkillsErrorsForExplicitMissingDirectory(t *testing.T) {
	root := filepath.Join(t.TempDir(), "missing")
	_, err := LoadRuntimeSkills(config.Config{SkillsDirectory: root})
	if err == nil {
		t.Fatal("LoadRuntimeSkills() error = nil, want missing directory error")
	}
}

func TestLoadRuntimeSkillsFallsBackToEmbeddedOnlyWhenUnconfigured(t *testing.T) {
	skills, err := LoadRuntimeSkills(config.Config{})
	if err != nil {
		t.Fatalf("LoadRuntimeSkills() error = %v", err)
	}
	if !skillSliceContains(skills, "jellyfin") {
		t.Fatalf("skills missing embedded jellyfin entry: %#v", skills)
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

func TestDiscordPromptsAvoidToolInventoryForCasualReplies(t *testing.T) {
	systemPrompt, err := LoadPromptTemplate(systemPromptPath)
	if err != nil {
		t.Fatalf("LoadPromptTemplate(system) error = %v", err)
	}
	triagePrompt, err := LoadPromptTemplate(discordTriagePromptPath)
	if err != nil {
		t.Fatalf("LoadPromptTemplate(discord triage) error = %v", err)
	}
	for name, prompt := range map[string]string{
		"system":         systemPrompt,
		"discord triage": triagePrompt,
	} {
		if !strings.Contains(prompt, "tool stack") && !strings.Contains(prompt, "inventory") {
			t.Fatalf("%s prompt missing casual capability inventory guardrail:\n%s", name, prompt)
		}
		if !strings.Contains(prompt, "introduction") && !strings.Contains(prompt, "introducing yourself") {
			t.Fatalf("%s prompt missing introduction guidance:\n%s", name, prompt)
		}
		if !strings.Contains(prompt, "talk about yourself") {
			t.Fatalf("%s prompt missing talk-about-yourself guidance:\n%s", name, prompt)
		}
	}
}

func TestNewDoesNotCreateLLMClientDuringStartup(t *testing.T) {
	skills := filepath.Join(t.TempDir(), "skills")
	writeSkill(t, skills, "jellyfin", "jellyfin")
	agent, err := New(config.Config{
		BotPublicName:     "TestBot",
		Provider:          "unsupported-provider",
		MaxToolIterations: 1,
		SkillsDirectory:   skills,
		CodexAuthStore:    filepath.Join(t.TempDir(), "missing-auth.json"),
		CodexAuthProfile:  "test",
		CodexBaseURL:      "https://example.test",
		RuntimeProfiles: map[string]config.RuntimeProfile{
			"discord_triage": {Model: "gpt-test"},
		},
	}, tools.NewRegistry(config.Config{}))
	if err != nil {
		t.Fatalf("New() error = %v, want startup without LLM client construction", err)
	}
	if agent.client != nil || len(agent.clients) != 0 {
		t.Fatalf("agent clients initialized during startup: client=%T clients=%d", agent.client, len(agent.clients))
	}
	if !strings.Contains(agent.discordTriagePrompt, "The bot's public name is TestBot") || strings.Contains(agent.discordTriagePrompt, "{{bot_name}}") {
		t.Fatalf("discord triage prompt did not render configured bot name:\n%s", agent.discordTriagePrompt)
	}
}

func TestLoadSystemPromptDoesNotInlineAllSkills(t *testing.T) {
	root := t.TempDir()
	skills := filepath.Join(root, "skills")
	writeSkill(t, skills, "jellyfin", "jellyfin")

	prompt, err := LoadSystemPrompt(config.Config{BotPublicName: "TestBot", SkillsDirectory: skills})
	if err != nil {
		t.Fatalf("LoadSystemPrompt() error = %v", err)
	}
	if strings.Contains(prompt, "## Skill: jellyfin") {
		t.Fatalf("LoadSystemPrompt() inlined runtime skills:\n%s", prompt)
	}
}

func TestReloadSkillsUsesRuntimeSkillDir(t *testing.T) {
	root := t.TempDir()
	skills := filepath.Join(root, "skills")
	writeSkill(t, skills, "jellyfin", "jellyfin")

	agent := &Agent{cfg: config.Config{BotPublicName: "TestBot", SkillsDirectory: skills}}
	if err := agent.ReloadSkills(); err != nil {
		t.Fatalf("ReloadSkills() error = %v", err)
	}
	if len(agent.skills) != 1 || agent.skills[0].Name != "jellyfin" {
		t.Fatalf("skills = %#v", agent.skills)
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
	call.Function.Name = "memory_get"
	call.Function.Arguments = `{"scope":"","key":"missing"}`

	_, err := agent.executeTool(context.Background(), Request{}, call, tools.ToolPolicy{})
	if err == nil || !strings.Contains(err.Error(), "scope is required") {
		t.Fatalf("executeTool() error = %v, want scope error", err)
	}

	output := logs.String()
	for _, want := range []string{
		`agent tool call start: name=memory_get args={"key":"missing","scope":""}`,
		`agent tool call failed: name=memory_get`,
		`scope is required`,
	} {
		if !strings.Contains(output, want) {
			t.Fatalf("tool logs missing %q:\n%s", want, output)
		}
	}
}

func TestExecuteToolEmitsAuditRecord(t *testing.T) {
	dir := t.TempDir()
	agent := &Agent{registry: tools.NewRegistry(config.Config{MemoriesDirectory: dir})}
	var records []ToolAuditRecord
	var call llm.ToolCall
	call.Function.Name = "memory_upsert"
	call.Function.Arguments = toolArgsJSON(t, map[string]any{"scope": "general", "key": "audit", "content": "hello"})

	_, err := agent.executeTool(context.Background(), Request{ToolAudit: func(record ToolAuditRecord) {
		records = append(records, record)
	}}, call, tools.ToolPolicy{})
	if err != nil {
		t.Fatalf("executeTool() error = %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("audit records = %d, want 1", len(records))
	}
	if records[0].Name != "memory_upsert" || records[0].ArgumentsSummary == "" || records[0].ResultSummary == "" || records[0].CompletedAt.Before(records[0].StartedAt) {
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

func TestRemovedServiceToolIsUnavailable(t *testing.T) {
	agent := &Agent{registry: tools.NewRegistry(config.Config{})}
	var call llm.ToolCall
	call.Function.Name = "seerr_resolve_issue"
	call.Function.Arguments = `{"issue_id":"42"}`

	_, err := agent.executeTool(context.Background(), Request{}, call, tools.ToolPolicy{ReadOnly: true})
	if err == nil || !strings.Contains(err.Error(), "not available") {
		t.Fatalf("executeTool() error = %v, want unavailable tool error", err)
	}
}

func TestReadOnlyPolicyAllowsMemoryWrites(t *testing.T) {
	dir := t.TempDir()
	agent := &Agent{registry: tools.NewRegistry(config.Config{MemoriesDirectory: dir})}
	var call llm.ToolCall
	call.Function.Name = "memory_upsert"
	call.Function.Arguments = `{"scope":"general","key":"test","content":"durable note"}`

	if _, err := agent.executeTool(context.Background(), Request{}, call, tools.ToolPolicy{ReadOnly: true, Groups: []string{"memory"}}); err != nil {
		t.Fatalf("executeTool() error = %v", err)
	}
}

func TestNonAdminDiscordMemoryAccessIsScopedToRequester(t *testing.T) {
	dir := t.TempDir()
	agent := &Agent{registry: tools.NewRegistry(config.Config{MemoriesDirectory: dir})}
	for _, key := range []string{"user-1/preferences", "user-2/preferences"} {
		var seed llm.ToolCall
		seed.Function.Name = "memory_upsert"
		seed.Function.Arguments = toolArgsJSON(t, map[string]any{"scope": "discord_user", "key": key, "content": "note for " + key})
		if _, err := agent.executeTool(context.Background(), Request{}, seed, tools.ToolPolicy{Groups: []string{"memory"}}); err != nil {
			t.Fatalf("seed memory %s: %v", key, err)
		}
	}

	var list llm.ToolCall
	list.Function.Name = "memory_list"
	list.Function.Arguments = toolArgsJSON(t, map[string]any{"scope": "discord_user"})
	raw, err := agent.executeTool(context.Background(), Request{
		Source:   "discord_mention",
		AuthorID: "user-1",
		Audience: "non_admin",
	}, list, tools.ToolPolicy{Groups: []string{"memory"}})
	if err != nil {
		t.Fatalf("memory_list error = %v", err)
	}
	text := compactLogValue(raw, 2000)
	if !strings.Contains(text, "user-1/preferences") || strings.Contains(text, "user-2/preferences") {
		t.Fatalf("memory_list leaked or omitted scoped memory: %s", text)
	}

	var search llm.ToolCall
	search.Function.Name = "memory_search"
	search.Function.Arguments = toolArgsJSON(t, map[string]any{"scope": "discord_user", "query": "note"})
	raw, err = agent.executeTool(context.Background(), Request{
		Source:   "discord_mention",
		AuthorID: "user-1",
		Audience: "non_admin",
	}, search, tools.ToolPolicy{Groups: []string{"memory"}})
	if err != nil {
		t.Fatalf("memory_search error = %v", err)
	}
	text = compactLogValue(raw, 2000)
	if !strings.Contains(text, "user-1/preferences") || strings.Contains(text, "user-2/preferences") {
		t.Fatalf("memory_search leaked or omitted scoped memory: %s", text)
	}

	var getOther llm.ToolCall
	getOther.Function.Name = "memory_get"
	getOther.Function.Arguments = toolArgsJSON(t, map[string]any{"scope": "discord_user", "key": "user-2/preferences"})
	_, err = agent.executeTool(context.Background(), Request{
		Source:   "discord_mention",
		AuthorID: "user-1",
		Audience: "non_admin",
	}, getOther, tools.ToolPolicy{Groups: []string{"memory"}})
	if err == nil || !strings.Contains(err.Error(), "limited to key prefix") {
		t.Fatalf("memory_get error = %v, want scoped denial", err)
	}
}

func TestSandboxReviewRequestsApprovalForRiskyScripts(t *testing.T) {
	reviewer := &recordingClient{responses: []llm.ChatResponse{responseWithMessage(llm.Message{
		Role:    "assistant",
		Content: `{"decision":"ask","reason":"mutates Sonarr queue","mutating":true,"permissions":{"allow_net":["sonarr.local:8989"],"allow_env":["SONARR_API_KEY"]}}`,
	})}}
	agent := &Agent{
		cfg:      config.Config{Model: "gpt-test"},
		clients:  map[string]llm.Client{"sandbox_review": reviewer},
		registry: tools.NewRegistry(config.Config{SonarrBaseURL: "http://sonarr.local:8989", SonarrAPIKey: "secret"}),
	}
	var call llm.ToolCall
	call.Function.Name = "sandbox_run_typescript"
	call.Function.Arguments = `{"purpose":"delete queue item","script":"await fetch('http://sonarr.local:8989/api/v3/queue/1',{method:'DELETE'})"}`

	called := false
	_, err := agent.executeTool(context.Background(), Request{
		ToolApproval: func(_ context.Context, request ToolApprovalRequest) (ToolApprovalDecision, error) {
			called = true
			if request.Name != "sandbox_run_typescript" || !request.Destructive || !request.Mutating {
				t.Fatalf("approval request = %#v", request)
			}
			return ToolApprovalDecision{Approved: false, Actor: "owner", Reason: "tool call denied"}, nil
		},
	}, call, tools.ToolPolicy{})
	if !called {
		t.Fatal("ToolApproval was not called")
	}
	if err == nil || !strings.Contains(err.Error(), "denied") {
		t.Fatalf("executeTool() error = %v, want approval denial", err)
	}
}

func TestSandboxReviewRejectsApprovalWithoutCallback(t *testing.T) {
	reviewer := &recordingClient{responses: []llm.ChatResponse{responseWithMessage(llm.Message{
		Role:    "assistant",
		Content: `{"decision":"ask","reason":"mutates Sonarr queue","mutating":true,"permissions":{"allow_net":["sonarr.local:8989"],"allow_env":["SONARR_API_KEY"]}}`,
	})}}
	agent := &Agent{
		cfg:      config.Config{Model: "gpt-test"},
		clients:  map[string]llm.Client{"sandbox_review": reviewer},
		registry: tools.NewRegistry(config.Config{SonarrBaseURL: "http://sonarr.local:8989", SonarrAPIKey: "secret"}),
	}
	var call llm.ToolCall
	call.Function.Name = "sandbox_run_typescript"
	call.Function.Arguments = `{"purpose":"delete queue item","script":"await fetch('http://sonarr.local:8989/api/v3/queue/1',{method:'DELETE'})"}`

	_, err := agent.executeTool(context.Background(), Request{}, call, tools.ToolPolicy{})
	if err == nil || !strings.Contains(err.Error(), "requires approval") {
		t.Fatalf("executeTool() error = %v, want missing approval callback error", err)
	}
}

func TestToolPolicyIsReadOnlyOutsideSeerrIssues(t *testing.T) {
	agent := &Agent{}
	if policy := agent.toolPolicy(Request{Source: "discord_thread"}); policy.ReadOnly {
		t.Fatal("discord thread policy is read-only")
	}
	if policy := agent.toolPolicy(Request{Source: "automation_cron"}); !policy.ReadOnly {
		t.Fatal("automation policy is not read-only")
	}
	if policy := agent.toolPolicy(Request{Source: "automation_cron", Content: "Run the hourly stale import handler."}); policy.ReadOnly {
		t.Fatal("stale import handler policy is read-only")
	}
	if policy := agent.toolPolicy(Request{Source: "seerr_issue_created"}); policy.ReadOnly {
		t.Fatal("seerr issue policy is read-only")
	}
}

func TestToolPolicySelectsRelevantDiscordGroups(t *testing.T) {
	agent := &Agent{}
	policy := agent.toolPolicy(Request{Source: "discord_mention", Content: "Ist Project Hail Mary auf Jellyfin verfuegbar?"})
	if policy.ReadOnly {
		t.Fatal("discord policy is read-only")
	}
	if !stringSliceContains(policy.Groups, "memory") || !stringSliceContains(policy.Groups, "jellyfin") || !stringSliceContains(policy.Groups, "web") {
		t.Fatalf("groups = %#v, want memory, jellyfin, and web", policy.Groups)
	}
	if stringSliceContains(policy.Groups, "sonarr") || stringSliceContains(policy.Groups, "filesystem") {
		t.Fatalf("groups = %#v, want no unrelated tool packs", policy.Groups)
	}
}

func TestToolPolicyKeepsMemoryCapabilityInAgentWorkflows(t *testing.T) {
	agent := &Agent{}
	for _, req := range []Request{
		{Source: "discord_thread"},
		{Source: "automation_cron"},
		{Source: "seerr_issue_created"},
		{Source: "discord_slash_jellyfin", ToolGroups: []string{"jellyfin"}},
	} {
		policy := agent.toolPolicy(req)
		if !stringSliceContains(policy.Groups, "memory") {
			t.Fatalf("groups for %s = %#v, want memory", req.Source, policy.Groups)
		}
	}
}

func TestToolPolicyHonorsExplicitSlashCommandGroups(t *testing.T) {
	agent := &Agent{}
	policy := agent.toolPolicy(Request{Source: "discord_slash_jellyfin", Content: "anything", ToolGroups: []string{"jellyfin"}})
	if policy.ReadOnly {
		t.Fatal("discord slash policy is read-only")
	}
	if !stringSliceContains(policy.Groups, "memory") || !stringSliceContains(policy.Groups, "jellyfin") || !stringSliceContains(policy.Groups, "web") {
		t.Fatalf("groups = %#v, want memory, jellyfin, and web", policy.Groups)
	}
	if stringSliceContains(policy.Groups, "sonarr") || stringSliceContains(policy.Groups, "filesystem") {
		t.Fatalf("groups = %#v, want explicit groups only", policy.Groups)
	}
}

func TestSkillsForRequestHonorsExplicitSlashCommandGroups(t *testing.T) {
	agent := &Agent{skills: []Skill{{Name: "jellyfin"}, {Name: "sonarr"}}}
	skills := agent.skillsForRequest(Request{Source: "discord_slash_jellyfin", ToolGroups: []string{"jellyfin"}})
	if len(skills) != 1 || skills[0].Name != "jellyfin" {
		t.Fatalf("skills = %#v, want jellyfin only", skills)
	}
}

func TestToolPolicyKeepsWebCapabilityInContext(t *testing.T) {
	agent := &Agent{}
	policy := agent.toolPolicy(Request{Source: "discord_thread", Content: "download queue is stuck"})
	if !stringSliceContains(policy.Groups, "memory") || !stringSliceContains(policy.Groups, "sabnzbd") {
		t.Fatalf("groups = %#v, want memory and sabnzbd", policy.Groups)
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
	prompt := agent.toolContextPrompt(tools.ToolPolicy{ReadOnly: true, SandboxServices: true, Groups: []string{"sandbox", "web"}})
	for _, want := range []string{
		"Selected tools by capability: sandbox (",
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
	toolCall.Function.Arguments = toolArgsJSON(t, map[string]any{"path": path})
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
		if !stringSliceContains(names, "sandbox_run_typescript") || !stringSliceContains(names, "web_search") || stringSliceContains(names, "fs_stat_path") {
			t.Fatalf("request %d tools = %#v, want sandbox and web tools without direct filesystem tools", i, names)
		}
	}
	if len(client.requests[1].Messages) == 0 || client.requests[1].Messages[len(client.requests[1].Messages)-1].Role != "tool" {
		t.Fatalf("second request did not propagate tool result messages: %#v", client.requests[1].Messages)
	}
	runtimeMessage := client.requests[0].Messages[3].Content
	if !strings.Contains(runtimeMessage, "callable=") || !strings.Contains(runtimeMessage, "sandbox_run_typescript") || !strings.Contains(runtimeMessage, "read_only=false") {
		t.Fatalf("runtime metadata missing selected tool inventory: %q", runtimeMessage)
	}
}

func TestRespondEmitsProgressForModelAndToolWork(t *testing.T) {
	root := t.TempDir()
	toolCall := llm.ToolCall{ID: "call_1", Type: "function"}
	toolCall.Function.Name = "memory_upsert"
	toolCall.Function.Arguments = toolArgsJSON(t, map[string]any{"scope": "general", "key": "progress", "content": "ok"})
	client := &recordingClient{responses: []llm.ChatResponse{
		responseWithMessage(llm.Message{Role: "assistant", ToolCalls: []llm.ToolCall{toolCall}}),
		responseWithMessage(llm.Message{Role: "assistant", Content: "done"}),
	}}
	agent := &Agent{
		cfg:           config.Config{Model: "gpt-test", MaxToolIterations: 2},
		client:        client,
		registry:      tools.NewRegistry(config.Config{MemoriesDirectory: root}),
		system:        "system",
		runtimePrompt: "model={{model}}; reasoning_effort={{reasoning_effort}}; callable={{callable_tools}}; read_only={{read_only}}",
	}
	var phases []string
	var toolNames []string
	_, err := agent.Respond(context.Background(), Request{
		Source:   "discord_thread",
		Audience: "admin",
		IsAdmin:  true,
		Content:  "check file permissions",
		Progress: func(event ProgressEvent) {
			phases = append(phases, event.Phase)
			if event.ToolName != "" {
				toolNames = append(toolNames, event.ToolName)
			}
		},
	})
	if err != nil {
		t.Fatalf("Respond() error = %v", err)
	}
	for _, want := range []string{"start", "model_start", "tools_selected", "tool_start", "tool_done", "finalizing"} {
		if !stringSliceContains(phases, want) {
			t.Fatalf("progress phases missing %q: %#v", want, phases)
		}
	}
	if !stringSliceContains(toolNames, "memory_upsert") {
		t.Fatalf("progress tool names = %#v, want memory_upsert", toolNames)
	}
}

func TestRespondCompactsOversizedRequestForRuntimeBudget(t *testing.T) {
	client := &recordingClient{responses: []llm.ChatResponse{
		responseWithMessage(llm.Message{Role: "assistant", Content: "ok"}),
	}}
	agent := &Agent{
		cfg: config.Config{
			Model:                       "tiny-model",
			MaxToolIterations:           1,
			ContextAutoCompact:          true,
			ContextReservedTokens:       0,
			ContextPreserveRecentTokens: 120,
			RuntimeProfiles: map[string]config.RuntimeProfile{
				"default": {Model: "tiny-model", ContextLimit: 2200, OutputLimit: 200},
			},
		},
		client:        client,
		registry:      tools.NewRegistry(config.Config{}),
		system:        "system",
		runtimePrompt: "runtime",
	}
	content := strings.Repeat("old request detail ", 2000) + "TAIL_MARKER"

	reply, err := agent.Respond(context.Background(), Request{Source: "manual", Author: "tester", Content: content})
	if err != nil {
		t.Fatalf("Respond() error = %v", err)
	}
	if reply != "ok" {
		t.Fatalf("reply = %q, want ok", reply)
	}
	if len(client.requests) != 1 {
		t.Fatalf("chat requests = %d, want 1", len(client.requests))
	}
	budget := agent.cfg.RuntimeContextBudget("default")
	if got := estimateMessagesTokens(client.requests[0].Messages); got > budget.UsableTokens {
		t.Fatalf("request estimated tokens = %d, want <= %d", got, budget.UsableTokens)
	}
	user := client.requests[0].Messages[len(client.requests[0].Messages)-1].Content
	if !strings.Contains(user, compactedMessageNoticeText) || !strings.Contains(user, "TAIL_MARKER") {
		t.Fatalf("compacted user message missing notice or tail marker:\n%s", user)
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
		RuntimeProfiles: map[string]config.RuntimeProfile{
			"discord_triage": {Model: "gpt-5.4-mini", ReasoningEffort: "none"},
		},
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
		runtimePrompt:      "audience={{audience}} requester_admin={{requester_admin}} requester_id={{requester_id}} seerr_user_id={{seerr_user_id}} automations={{automations}}",
		automationMetadata: fakeAutomationMetadata{},
	}
	metadata := agent.runtimeMetadata(Request{Source: "automation_cron", Audience: "automation", IsAdmin: true}, "gpt-test", "low", tools.ToolPolicy{ReadOnly: true})
	for _, want := range []string{"audience=automation", "requester_admin=true", "hourly-stale-import-handler", "cron: 0 * * * *", "2026-05-16T09:00:00Z"} {
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

func toolArgsJSON(t *testing.T, args map[string]any) string {
	t.Helper()
	data, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
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
