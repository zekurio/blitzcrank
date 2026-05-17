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
automations_enabled = true
automations_extra_dirs = ["/srv/blitzcrank/extra-automations"]
timezone = "Europe/Vienna"
run_timeout = "2m"

[runtime.profiles.default]
provider = "openrouter"
model = "openai/gpt-5.4"
reasoning_effort = "low"

[runtime.profiles.automation]
model = "anthropic/claude-sonnet-4.6"
reasoning_effort = "medium"

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
	if cfg.SkillsDirectory != "/srv/blitzcrank/skills" || cfg.Timezone != "Europe/Vienna" {
		t.Fatalf("runtime globals = skills=%q timezone=%q", cfg.SkillsDirectory, cfg.Timezone)
	}
	automation := cfg.RuntimeProfile("automation")
	if automation.Provider != "openrouter" || automation.Model != "anthropic/claude-sonnet-4.6" || automation.ReasoningEffort != "medium" {
		t.Fatalf("automation runtime = %#v", automation)
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
}

func TestDiscordSeerrUserMapParsesJSONEnv(t *testing.T) {
	t.Setenv("BLITZCRANK_CONFIG", filepath.Join(t.TempDir(), "missing.toml"))
	t.Setenv("OPENAI_API_KEY", "default-key")
	t.Setenv("DISCORD_SEERR_USER_MAP", `{"discord-user-1": 42, "discord-user-2": "84"}`)

	cfg, err := LoadRelaxed("")
	if err != nil {
		t.Fatalf("LoadRelaxed() error = %v", err)
	}
	if cfg.DiscordSeerrUserMap["discord-user-1"] != "42" || cfg.DiscordSeerrUserMap["discord-user-2"] != "84" {
		t.Fatalf("DiscordSeerrUserMap = %#v", cfg.DiscordSeerrUserMap)
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

func TestLegacyEnvStillWorks(t *testing.T) {
	t.Setenv("BLITZCRANK_CONFIG", filepath.Join(t.TempDir(), "missing.toml"))
	t.Setenv("OPENAI_API_KEY", "key")
	t.Setenv("CRON_ENABLED", "true")
	t.Setenv("CODEX_FAST_MODE", "true")

	cfg, err := LoadRelaxed("")
	if err != nil {
		t.Fatalf("LoadRelaxed() error = %v", err)
	}
	if !cfg.AutomationsEnabled {
		t.Fatal("AutomationsEnabled = false")
	}
	if cfg.CodexServiceTier != "fast" {
		t.Fatalf("CodexServiceTier = %q", cfg.CodexServiceTier)
	}
}
