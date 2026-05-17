package config

import (
	"encoding/json"
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
	t.Setenv("RUNTIME_DEFAULT_CONFIG_PATH", "")
	t.Setenv("RUNTIME_CONFIG_PATH", filepath.Join(t.TempDir(), "runtime.json"))
}

func TestRuntimeProfilesUseWorkflowOverrides(t *testing.T) {
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

func TestDiscordTriageRuntimeProfileUsesAgentPrefixedEnv(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "default-key")
	t.Setenv("AGENT_DEFAULT_PROVIDER", "openai-compatible")
	t.Setenv("AGENT_DEFAULT_MODEL", "gpt-default")
	t.Setenv("AGENT_DISCORD_TRIAGE_PROVIDER", "openrouter")
	t.Setenv("AGENT_DISCORD_TRIAGE_MODEL", "openai/gpt-5.4-mini")
	t.Setenv("AGENT_DISCORD_TRIAGE_REASONING_EFFORT", "low")

	cfg, err := LoadRelaxed("")
	if err != nil {
		t.Fatalf("LoadRelaxed() error = %v", err)
	}
	triage := cfg.RuntimeProfile("discord_triage")
	if triage.Provider != "openrouter" || triage.Model != "openai/gpt-5.4-mini" || triage.ReasoningEffort != "low" {
		t.Fatalf("discord triage runtime = %#v", triage)
	}
}

func TestDiscordSeerrUserMapParsesJSON(t *testing.T) {
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

func TestRuntimeMarkdownDirectoriesAreSkillsAndAutomationsOnly(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "key")
	t.Setenv("SKILLS_DIR", "/srv/blitzcrank/skills")
	t.Setenv("AUTOMATIONS_DIR", "/srv/blitzcrank/automations")

	cfg, err := LoadRelaxed("")
	if err != nil {
		t.Fatalf("LoadRelaxed() error = %v", err)
	}
	if cfg.SkillsDirectory != "/srv/blitzcrank/skills" || cfg.AutomationsDirectory != "/srv/blitzcrank/automations" {
		t.Fatalf("runtime dirs = skills=%q automations=%q", cfg.SkillsDirectory, cfg.AutomationsDirectory)
	}
}

func TestRuntimeConfigFileOverridesProfilesAndGlobals(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime.json")
	if err := SetRuntimeConfigValue(path, "runtime.automation.model", "anthropic/claude-sonnet-4.6"); err != nil {
		t.Fatal(err)
	}
	if err := SetRuntimeConfigValue(path, "runtime.automation.reasoning_effort", "medium"); err != nil {
		t.Fatal(err)
	}
	if err := SetRuntimeConfigValue(path, "automations_enabled", "true"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENAI_API_KEY", "key")
	t.Setenv("AGENT_AUTOMATION_MODEL", "gpt-env")
	t.Setenv("AUTOMATIONS_ENABLED", "false")
	t.Setenv("RUNTIME_CONFIG_PATH", path)

	cfg, err := LoadRelaxed("")
	if err != nil {
		t.Fatalf("LoadRelaxed() error = %v", err)
	}
	if got := cfg.RuntimeProfile("automation").Model; got != "anthropic/claude-sonnet-4.6" {
		t.Fatalf("automation model = %q", got)
	}
	if got := cfg.RuntimeProfile("automation").ReasoningEffort; got != "medium" {
		t.Fatalf("automation reasoning effort = %q", got)
	}
	if !cfg.AutomationsEnabled {
		t.Fatal("AutomationsEnabled = false")
	}
	value, err := GetRuntimeConfigValue(cfg, "runtime.automation.model")
	if err != nil || value != "anthropic/claude-sonnet-4.6" {
		t.Fatalf("GetRuntimeConfigValue() = (%q, %v)", value, err)
	}
}

func TestRuntimeDefaultProfileChangesFlowToWorkflowProfiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime.json")
	if err := SetRuntimeConfigValue(path, "runtime.default.provider", "openrouter"); err != nil {
		t.Fatal(err)
	}
	if err := SetRuntimeConfigValue(path, "runtime.default.model", "openai/gpt-5.4"); err != nil {
		t.Fatal(err)
	}
	if err := SetRuntimeConfigValue(path, "runtime.default.reasoning_effort", "low"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENAI_API_KEY", "key")
	t.Setenv("AGENT_DEFAULT_PROVIDER", "openai-compatible")
	t.Setenv("AGENT_DEFAULT_MODEL", "gpt-old")
	t.Setenv("AGENT_DEFAULT_REASONING_EFFORT", "medium")
	t.Setenv("RUNTIME_CONFIG_PATH", path)

	cfg, err := LoadRelaxed("")
	if err != nil {
		t.Fatalf("LoadRelaxed() error = %v", err)
	}
	for _, name := range []string{"seerr", "discord", "automation"} {
		profile := cfg.RuntimeProfile(name)
		if profile.Provider != "openrouter" || profile.Model != "openai/gpt-5.4" || profile.ReasoningEffort != "low" {
			t.Fatalf("%s runtime = %#v, want updated default profile", name, profile)
		}
	}
}

func TestRuntimeWorkflowOverrideDoesNotFreezeDefaultFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime.json")
	if err := SetRuntimeConfigValue(path, "runtime.default.provider", "openrouter"); err != nil {
		t.Fatal(err)
	}
	if err := SetRuntimeConfigValue(path, "runtime.default.model", "openai/gpt-5.4"); err != nil {
		t.Fatal(err)
	}
	if err := SetRuntimeConfigValue(path, "runtime.default.reasoning_effort", "high"); err != nil {
		t.Fatal(err)
	}
	if err := SetRuntimeConfigValue(path, "runtime.automation.model", "anthropic/claude-sonnet-4.6"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENAI_API_KEY", "key")
	t.Setenv("AGENT_DEFAULT_PROVIDER", "openai-compatible")
	t.Setenv("AGENT_DEFAULT_MODEL", "gpt-old")
	t.Setenv("AGENT_DEFAULT_REASONING_EFFORT", "medium")
	t.Setenv("RUNTIME_CONFIG_PATH", path)

	cfg, err := LoadRelaxed("")
	if err != nil {
		t.Fatalf("LoadRelaxed() error = %v", err)
	}
	automation := cfg.RuntimeProfile("automation")
	if automation.Provider != "openrouter" || automation.Model != "anthropic/claude-sonnet-4.6" || automation.ReasoningEffort != "high" {
		t.Fatalf("automation runtime = %#v, want model override with inherited defaults", automation)
	}
}

func TestRuntimeConfigFileIsSeededFromEnvWhenMissing(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime.json")
	t.Setenv("OPENAI_API_KEY", "key")
	t.Setenv("AGENT_DEFAULT_PROVIDER", "openai-compatible")
	t.Setenv("AGENT_DEFAULT_MODEL", "gpt-env")
	t.Setenv("AGENT_AUTOMATION_PROVIDER", "openrouter")
	t.Setenv("AGENT_AUTOMATION_MODEL", "anthropic/claude-sonnet-4.6")
	t.Setenv("AGENT_AUTOMATION_REASONING_EFFORT", "medium")
	t.Setenv("SKILLS_DIR", "/srv/blitzcrank/skills")
	t.Setenv("AUTOMATIONS_DIR", "/srv/blitzcrank/automations")
	t.Setenv("AUTOMATIONS_ENABLED", "true")
	t.Setenv("TIMEZONE", "Europe/Vienna")
	t.Setenv("RUNTIME_CONFIG_PATH", path)

	cfg, err := LoadRelaxed("")
	if err != nil {
		t.Fatalf("LoadRelaxed() error = %v", err)
	}
	if cfg.RuntimeProfile("automation").Model != "anthropic/claude-sonnet-4.6" {
		t.Fatalf("automation runtime = %#v", cfg.RuntimeProfile("automation"))
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	var file RuntimeFile
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if file.SkillsDirectory != "/srv/blitzcrank/skills" || file.AutomationsDirectory != "/srv/blitzcrank/automations" {
		t.Fatalf("seeded dirs = skills=%q automations=%q", file.SkillsDirectory, file.AutomationsDirectory)
	}
	if file.AutomationsEnabled == nil || !*file.AutomationsEnabled {
		t.Fatalf("seeded automations_enabled = %#v", file.AutomationsEnabled)
	}
	if file.Timezone != "Europe/Vienna" {
		t.Fatalf("seeded timezone = %q", file.Timezone)
	}
	if got := file.RuntimeProfiles["automation"]; got.Provider != "openrouter" || got.Model != "anthropic/claude-sonnet-4.6" || got.ReasoningEffort != "medium" {
		t.Fatalf("seeded automation runtime = %#v", got)
	}
	if got := file.RuntimeProfiles["default"].Model; got != "gpt-env" {
		t.Fatalf("seeded default model = %q", got)
	}
}

func TestRuntimeConfigSeedDoesNotMaterializeDefaultWorkflowProfiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime.json")
	t.Setenv("OPENAI_API_KEY", "key")
	t.Setenv("AGENT_DEFAULT_PROVIDER", "openai-compatible")
	t.Setenv("AGENT_DEFAULT_MODEL", "gpt-env")
	t.Setenv("RUNTIME_CONFIG_PATH", path)

	if _, err := LoadRelaxed(""); err != nil {
		t.Fatalf("LoadRelaxed() error = %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	var file RuntimeFile
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	for _, name := range []string{"seerr", "discord", "automation"} {
		if _, ok := file.RuntimeProfiles[name]; ok {
			t.Fatalf("seeded runtime profile %q = %#v, want inherited from default", name, file.RuntimeProfiles[name])
		}
	}
	if file.RuntimeProfiles["default"].Model != "gpt-env" {
		t.Fatalf("default profile = %#v", file.RuntimeProfiles["default"])
	}
}

func TestLegacyCronEnabledStillWorks(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "key")
	t.Setenv("CRON_ENABLED", "true")

	cfg, err := LoadRelaxed("")
	if err != nil {
		t.Fatalf("LoadRelaxed() error = %v", err)
	}
	if !cfg.AutomationsEnabled {
		t.Fatal("AutomationsEnabled = false")
	}

	path := filepath.Join(t.TempDir(), "runtime.json")
	if err := os.WriteFile(path, []byte(`{"cron_enabled": true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AUTOMATIONS_ENABLED", "false")
	t.Setenv("RUNTIME_CONFIG_PATH", path)
	cfg, err = LoadRelaxed("")
	if err != nil {
		t.Fatalf("LoadRelaxed() error = %v", err)
	}
	if !cfg.AutomationsEnabled {
		t.Fatal("legacy cron_enabled did not enable automations")
	}
}

func TestRuntimeDefaultConfigFileProvidesMutableDefaults(t *testing.T) {
	dir := t.TempDir()
	defaultsPath := filepath.Join(dir, "defaults.json")
	runtimePath := filepath.Join(dir, "runtime.json")
	if err := os.WriteFile(defaultsPath, []byte(`{
  "skills_dir": "/nix/store/blitzcrank/skills",
  "automations_dir": "/nix/store/blitzcrank/automations",
  "automations_enabled": true,
  "timezone": "Europe/Vienna",
  "runtime_profiles": {
    "automation": {
      "provider": "openrouter",
      "model": "anthropic/claude-sonnet-4.6",
      "reasoning_effort": "medium"
    }
  }
}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SetRuntimeConfigValue(runtimePath, "runtime.automation.model", "gpt-runtime"); err != nil {
		t.Fatal(err)
	}
	if err := SetRuntimeConfigValue(runtimePath, "automations_enabled", "false"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENAI_API_KEY", "key")
	t.Setenv("RUNTIME_DEFAULT_CONFIG_PATH", defaultsPath)
	t.Setenv("RUNTIME_CONFIG_PATH", runtimePath)

	cfg, err := LoadRelaxed("")
	if err != nil {
		t.Fatalf("LoadRelaxed() error = %v", err)
	}
	if cfg.SkillsDirectory != "/nix/store/blitzcrank/skills" {
		t.Fatalf("SkillsDirectory = %q", cfg.SkillsDirectory)
	}
	if cfg.Timezone != "Europe/Vienna" {
		t.Fatalf("Timezone = %q", cfg.Timezone)
	}
	automation := cfg.RuntimeProfile("automation")
	if automation.Provider != "openrouter" {
		t.Fatalf("automation provider = %q", automation.Provider)
	}
	if automation.Model != "gpt-runtime" {
		t.Fatalf("automation model = %q", automation.Model)
	}
	if automation.ReasoningEffort != "medium" {
		t.Fatalf("automation reasoning effort = %q", automation.ReasoningEffort)
	}
	if cfg.AutomationsEnabled {
		t.Fatal("AutomationsEnabled = true")
	}
}

func TestRuntimeDefaultConfigFileDoesNotSeedMutableOverrides(t *testing.T) {
	dir := t.TempDir()
	defaultsPath := filepath.Join(dir, "defaults.json")
	runtimePath := filepath.Join(dir, "runtime.json")
	if err := os.WriteFile(defaultsPath, []byte(`{
  "skills_dir": "/nix/store/blitzcrank/skills",
  "automations_dir": "/nix/store/blitzcrank/automations",
  "automations_enabled": true,
  "timezone": "Europe/Vienna",
  "runtime_profiles": {
    "automation": {
      "provider": "openrouter",
      "model": "anthropic/claude-sonnet-4.6",
      "reasoning_effort": "medium"
    }
  }
}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENAI_API_KEY", "key")
	t.Setenv("RUNTIME_DEFAULT_CONFIG_PATH", defaultsPath)
	t.Setenv("RUNTIME_CONFIG_PATH", runtimePath)

	cfg, err := LoadRelaxed("")
	if err != nil {
		t.Fatalf("LoadRelaxed() error = %v", err)
	}
	if cfg.SkillsDirectory != "/nix/store/blitzcrank/skills" || cfg.Timezone != "Europe/Vienna" {
		t.Fatalf("cfg = %#v, want default file values", cfg)
	}
	data, err := os.ReadFile(runtimePath)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	var file RuntimeFile
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if file.SkillsDirectory != "" || file.AutomationsDirectory != "" || file.AutomationsEnabled != nil || file.Timezone != "" || len(file.RuntimeProfiles) != 0 {
		t.Fatalf("seeded runtime file = %#v, want no persisted defaults", file)
	}
}
