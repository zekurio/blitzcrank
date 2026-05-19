package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func setStrictLoadDefaults(t *testing.T) {
	t.Helper()
	t.Setenv("OPENAI_API_KEY", "key")
	t.Setenv("AGENT_DEFAULT_PROVIDER", "openai-compatible")
	t.Setenv("AGENT_DEFAULT_MODEL", "gpt-default")
	t.Setenv("BLITZCRANK_CONFIG", filepath.Join(t.TempDir(), "missing.toml"))
}

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "blitzcrank.toml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestDotenvProvidesConfigPathAndOverridesTOML(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "blitzcrank.toml")
	dotenvPath := filepath.Join(dir, ".env")
	if err := os.WriteFile(configPath, []byte(`
[bot]
public_name = "from-toml"

[llm.openai]
api_key = "key-from-toml"
`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dotenvPath, []byte(`
BLITZCRANK_CONFIG=`+configPath+`
BOT_PUBLIC_NAME=from-dotenv
OPENAI_API_KEY=key-from-dotenv
`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BLITZCRANK_CONFIG", "")
	t.Setenv("BOT_PUBLIC_NAME", "")
	t.Setenv("OPENAI_API_KEY", "")

	cfg, err := Load(dotenvPath)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.ConfigPath != configPath {
		t.Fatalf("ConfigPath = %q, want %q", cfg.ConfigPath, configPath)
	}
	if cfg.BotPublicName != "from-dotenv" {
		t.Fatalf("BotPublicName = %q", cfg.BotPublicName)
	}
	if cfg.OpenAIAPIKey != "key-from-dotenv" {
		t.Fatalf("OpenAIAPIKey = %q", cfg.OpenAIAPIKey)
	}
}

func TestTOMLConfigLoadsReadableSections(t *testing.T) {
	path := writeConfig(t, `
[discord]
channel_id = "channel-1"
triage_threshold = 0.6
thread_archive_minutes = 60
context_recent_messages = 5
seerr_user_map = { "discord-user-1" = "42" }

[seerr]
base_url = "http://seerr.local"
api_key = "seerr-key"
webhook_listen_addr = "127.0.0.1:8080"

[runtime]
skills_dir = "/srv/blitzcrank/skills"
automations_dir = "/srv/blitzcrank/automations"
memories_dir = "/srv/blitzcrank/memories"
automations_enabled = true
automations_extra_dirs = ["/srv/blitzcrank/extra-automations"]
timezone = "Europe/Vienna"
run_timeout = "2m"

[runtime.context]
reserved_tokens = 1234
tail_turns = 3
preserve_recent_tokens = 4567

[runtime.profiles.default]
provider = "openrouter"
model = "openai/gpt-5.4"
reasoning_effort = "low"
context_limit = 64000
output_limit = 4096

[runtime.profiles.automation]
model = "anthropic/claude-sonnet-4.6"
reasoning_effort = "medium"
context_limit = 200000
output_limit = 32000

[llm.openrouter]
api_key = "router-key"
`)
	t.Setenv("BLITZCRANK_CONFIG", path)

	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.AgentDiscordChannelID != "channel-1" || cfg.DiscordTriageThreshold != 0.6 {
		t.Fatalf("discord config = %#v", cfg)
	}
	if cfg.DiscordSeerrUserMap["discord-user-1"] != "42" {
		t.Fatalf("DiscordSeerrUserMap = %#v", cfg.DiscordSeerrUserMap)
	}
	if cfg.SkillsDirectory != "/srv/blitzcrank/skills" || cfg.MemoriesDirectory != "/srv/blitzcrank/memories" || cfg.Timezone != "Europe/Vienna" {
		t.Fatalf("runtime globals = skills=%q memories=%q timezone=%q", cfg.SkillsDirectory, cfg.MemoriesDirectory, cfg.Timezone)
	}
	if cfg.ContextReservedTokens != 1234 || cfg.ContextTailTurns != 3 || cfg.ContextPreserveRecentTokens != 4567 {
		t.Fatalf("context globals = reserved=%d tail=%d preserve=%d", cfg.ContextReservedTokens, cfg.ContextTailTurns, cfg.ContextPreserveRecentTokens)
	}
	automation := cfg.RuntimeProfile("automation")
	if automation.Provider != "openrouter" || automation.Model != "anthropic/claude-sonnet-4.6" || automation.ReasoningEffort != "medium" || automation.ContextLimit != 200000 || automation.OutputLimit != 32000 {
		t.Fatalf("automation runtime = %#v", automation)
	}
	defaultBudget := cfg.RuntimeContextBudget("default")
	if defaultBudget.ContextLimit != 64000 || defaultBudget.OutputLimit != 4096 || defaultBudget.UsableTokens != 59904 {
		t.Fatalf("default context budget = %#v", defaultBudget)
	}
}

func TestEnvOverridesTOMLConfig(t *testing.T) {
	path := writeConfig(t, `
[runtime]
automations_enabled = true

[runtime.profiles.default]
provider = "openrouter"
model = "openai/gpt-5.4"

[runtime.profiles.automation]
model = "model-from-file"

[llm.openai]
api_key = "key-from-file"
`)
	t.Setenv("BLITZCRANK_CONFIG", path)
	t.Setenv("OPENAI_API_KEY", "key-from-env")
	t.Setenv("AGENT_DEFAULT_PROVIDER", "openai-compatible")
	t.Setenv("AGENT_DEFAULT_MODEL", "model-from-env")
	t.Setenv("AGENT_AUTOMATION_MODEL", "automation-from-env")
	t.Setenv("AUTOMATIONS_ENABLED", "false")

	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.OpenAIAPIKey != "key-from-env" {
		t.Fatalf("OpenAIAPIKey = %q", cfg.OpenAIAPIKey)
	}
	if cfg.RuntimeProfile("default").Model != "model-from-env" {
		t.Fatalf("default runtime = %#v", cfg.RuntimeProfile("default"))
	}
	if cfg.RuntimeProfile("automation").Model != "automation-from-env" {
		t.Fatalf("automation runtime = %#v", cfg.RuntimeProfile("automation"))
	}
	if cfg.AutomationsEnabled {
		t.Fatal("AutomationsEnabled = true")
	}
}

func TestBlankEnvDoesNotOverrideTOMLConfig(t *testing.T) {
	path := writeConfig(t, `
[runtime.profiles.default]
provider = "openrouter"
model = "openai/gpt-5.4"

[llm.openrouter]
api_key = "router-key"
`)
	t.Setenv("BLITZCRANK_CONFIG", path)
	t.Setenv("OPENROUTER_API_KEY", "")
	t.Setenv("AGENT_DEFAULT_MODEL", "")

	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.OpenRouterAPIKey != "router-key" {
		t.Fatalf("OpenRouterAPIKey = %q", cfg.OpenRouterAPIKey)
	}
	if cfg.RuntimeProfile("default").Model != "openai/gpt-5.4" {
		t.Fatalf("default runtime = %#v", cfg.RuntimeProfile("default"))
	}
}

func TestCodexFastTOMLConfig(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
		want bool
	}{
		{
			name: "fast",
			body: `
[llm.codex]
fast = true
`,
			want: true,
		},
		{
			name: "standard",
			body: `
[llm.codex]
fast = false
`,
			want: false,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := writeConfig(t, tc.body)
			t.Setenv("BLITZCRANK_CONFIG", path)
			t.Setenv("OPENAI_API_KEY", "key")

			cfg, err := Load("")
			if err != nil {
				t.Fatalf("Load() error = %v", err)
			}
			if cfg.CodexFast != tc.want {
				t.Fatalf("CodexFast = %t, want %t", cfg.CodexFast, tc.want)
			}
		})
	}
}

func TestCodexFastEnvOverride(t *testing.T) {
	t.Setenv("BLITZCRANK_CONFIG", filepath.Join(t.TempDir(), "missing.toml"))
	t.Setenv("OPENAI_API_KEY", "key")
	t.Setenv("CODEX_FAST_MODE", "true")

	cfg, err := LoadRelaxed("")
	if err != nil {
		t.Fatalf("LoadRelaxed() error = %v", err)
	}
	if !cfg.CodexFast {
		t.Fatal("CodexFast = false")
	}
}

func TestRuntimeProfilesUseWorkflowOverrides(t *testing.T) {
	t.Setenv("BLITZCRANK_CONFIG", filepath.Join(t.TempDir(), "missing.toml"))
	t.Setenv("OPENAI_API_KEY", "default-key")
	t.Setenv("AGENT_DEFAULT_PROVIDER", "openai-compatible")
	t.Setenv("AGENT_DEFAULT_MODEL", "gpt-default")
	t.Setenv("AGENT_AUTOMATION_PROVIDER", "openrouter")
	t.Setenv("AGENT_AUTOMATION_MODEL", "anthropic/claude-sonnet-4.6")
	t.Setenv("AGENT_AUTOMATION_REASONING_EFFORT", "medium")
	t.Setenv("AGENT_SEERR_PROVIDER", "codex-oauth")
	t.Setenv("AGENT_SEERR_MODEL", "gpt-5.5")
	t.Setenv("AGENT_SEERR_REASONING_EFFORT", "high")

	cfg, err := LoadRelaxed("")
	if err != nil {
		t.Fatalf("LoadRelaxed() error = %v", err)
	}
	automation := cfg.RuntimeProfile("automation")
	if automation.Provider != "openrouter" || automation.Model != "anthropic/claude-sonnet-4.6" || automation.ReasoningEffort != "medium" {
		t.Fatalf("automation runtime = %#v", automation)
	}
	seerr := cfg.RuntimeProfile("seerr")
	if seerr.Provider != "codex-oauth" || seerr.Model != "gpt-5.5" || seerr.ReasoningEffort != "high" {
		t.Fatalf("seerr runtime = %#v", seerr)
	}
	triage := cfg.RuntimeProfile("discord_triage")
	if triage.Model != "gpt-5.4-mini" || triage.ReasoningEffort != "none" {
		t.Fatalf("discord triage runtime = %#v", triage)
	}
	sandboxReview := cfg.RuntimeProfile("sandbox_review")
	if sandboxReview.Model != "gpt-5.4-mini" || sandboxReview.ReasoningEffort != "none" {
		t.Fatalf("sandbox review runtime = %#v", sandboxReview)
	}
}

func TestCodexModelContextLimits(t *testing.T) {
	tests := []struct {
		model   string
		context int
		input   int
		output  int
	}{
		{model: "gpt-5.5", context: 1050000, input: 922000, output: 128000},
		{model: "gpt-5.4", context: 1050000, input: 922000, output: 128000},
		{model: "gpt-5.4-mini", context: 400000, input: 272000, output: 128000},
		{model: "gpt-5.3-codex", context: 400000, input: 272000, output: 128000},
		{model: "gpt-5.3-codex-spark", context: 128000, input: 100000, output: 32000},
		{model: "gpt-5.2", context: 400000, input: 272000, output: 128000},
	}
	for _, tt := range tests {
		t.Run(tt.model, func(t *testing.T) {
			cfg := Config{ModelsDevPath: filepath.Join("..", "llm", "models", "models.dev.json")}
			context, input, output := cfg.modelContextLimits("openai", tt.model)
			if context != tt.context || input != tt.input || output != tt.output {
				t.Fatalf("modelContextLimits(%q) = (%d, %d, %d), want (%d, %d, %d)", tt.model, context, input, output, tt.context, tt.input, tt.output)
			}
		})
	}
}

func TestRuntimeContextBudgetUsesModelsDevPath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "models.json")
	if err := os.WriteFile(path, []byte(`{
		"openai": {
			"id": "openai",
			"models": {
				"gpt-from-file": {"limit": {"context": 5000, "input": 4000, "output": 500}}
			}
		}
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := Config{
		Provider:              "codex-oauth",
		Model:                 "gpt-from-file",
		ModelsDevPath:         path,
		ContextReservedTokens: 100,
		ContextTailTurns:      2,
	}
	budget := cfg.RuntimeContextBudget("default")
	if budget.ContextLimit != 5000 || budget.InputLimit != 4000 || budget.OutputLimit != 500 || budget.UsableTokens != 3900 {
		t.Fatalf("budget = %#v", budget)
	}
}

func TestDiscordSeerrUserMapParsesJSONEnv(t *testing.T) {
	t.Setenv("BLITZCRANK_CONFIG", filepath.Join(t.TempDir(), "missing.toml"))
	t.Setenv("OPENAI_API_KEY", "default-key")
	t.Setenv("DISCORD_ADMIN_ROLE_ID", "role-admin")
	t.Setenv("DISCORD_SEERR_USER_MAP", `{"discord-user-1": 42, "discord-user-2": "84"}`)

	cfg, err := LoadRelaxed("")
	if err != nil {
		t.Fatalf("LoadRelaxed() error = %v", err)
	}
	if cfg.DiscordSeerrUserMap["discord-user-1"] != "42" || cfg.DiscordSeerrUserMap["discord-user-2"] != "84" {
		t.Fatalf("DiscordSeerrUserMap = %#v", cfg.DiscordSeerrUserMap)
	}
	if cfg.DiscordAdminRoleID != "role-admin" {
		t.Fatalf("DiscordAdminRoleID = %q, want role-admin", cfg.DiscordAdminRoleID)
	}
}

func TestLoadAllowsWebhookDisabledWithoutSeerrCredentials(t *testing.T) {
	setStrictLoadDefaults(t)
	t.Setenv("SEERR_WEBHOOK_LISTEN_ADDR", "")
	t.Setenv("SEERR_WEBHOOK_PATH", "")
	t.Setenv("SEERR_BASE_URL", "")
	t.Setenv("SEERR_API_KEY", "")

	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.SeerrWebhookListenAddr != "" {
		t.Fatalf("SeerrWebhookListenAddr = %q, want disabled", cfg.SeerrWebhookListenAddr)
	}
}

func TestLoadRequiresSeerrCredentialsWhenWebhookEnabled(t *testing.T) {
	setStrictLoadDefaults(t)
	t.Setenv("SEERR_WEBHOOK_LISTEN_ADDR", "127.0.0.1:8080")
	t.Setenv("SEERR_WEBHOOK_PATH", "/webhooks/seerr")
	t.Setenv("SEERR_BASE_URL", "")
	t.Setenv("SEERR_API_KEY", "")

	_, err := Load("")
	if err == nil {
		t.Fatal("Load() error = nil, want Seerr credential error")
	}
	if !strings.Contains(err.Error(), "SEERR_BASE_URL and SEERR_API_KEY are required") {
		t.Fatalf("Load() error = %v", err)
	}
}

func TestLoadAcceptsWebhookEnabledWithSeerrCredentials(t *testing.T) {
	setStrictLoadDefaults(t)
	t.Setenv("SEERR_WEBHOOK_LISTEN_ADDR", "127.0.0.1:8080")
	t.Setenv("SEERR_WEBHOOK_PATH", "/webhooks/seerr")
	t.Setenv("SEERR_BASE_URL", "http://seerr.local")
	t.Setenv("SEERR_API_KEY", "seerr-key")

	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.SeerrWebhookListenAddr != "127.0.0.1:8080" {
		t.Fatalf("SeerrWebhookListenAddr = %q", cfg.SeerrWebhookListenAddr)
	}
}

func TestLegacyCronEnvStillWorks(t *testing.T) {
	t.Setenv("BLITZCRANK_CONFIG", filepath.Join(t.TempDir(), "missing.toml"))
	t.Setenv("OPENAI_API_KEY", "key")
	t.Setenv("CRON_ENABLED", "true")

	cfg, err := LoadRelaxed("")
	if err != nil {
		t.Fatalf("LoadRelaxed() error = %v", err)
	}
	if !cfg.AutomationsEnabled {
		t.Fatal("AutomationsEnabled = false")
	}
}
