package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// sanitizeConfigEnv neutralizes ambient environment variables that TestLoadPrecedence and its
// siblings assert on, so the test result does not depend on the shell or a developer .env file.
func sanitizeConfigEnv(t *testing.T, keys ...string) {
	t.Helper()
	for _, key := range keys {
		t.Setenv(key, "")
	}
}

func TestLoadPrecedence(t *testing.T) {
	sanitizeConfigEnv(t,
		"PI_COMMAND",
		"AGENT_RUN_TIMEOUT",
		"PI_MODELS",
		"BOT_PUBLIC_NAME",
		"SEERR_WEBHOOK_PATH",
	)

	dir := t.TempDir()
	tomlPath := filepath.Join(dir, "blitzcrank.toml")
	tomlContents := `
[pi]
command = "pi-from-toml"
[pi.models]
default = "model-from-toml"
[runtime]
run_timeout = "7m"
`
	if err := os.WriteFile(tomlPath, []byte(tomlContents), 0o600); err != nil {
		t.Fatalf("write toml config: %v", err)
	}

	t.Setenv("BLITZCRANK_CONFIG", tomlPath)
	t.Setenv("PI_COMMAND", "pi-from-env")

	cfg, err := load(filepath.Join(t.TempDir(), "no-dotenv"), false)
	if err != nil {
		t.Fatalf("load() error = %v", err)
	}

	if cfg.PiCommand != "pi-from-env" {
		t.Errorf("PiCommand = %q, want %q (env must win over TOML)", cfg.PiCommand, "pi-from-env")
	}
	if cfg.RunTimeout != 7*time.Minute {
		t.Errorf("RunTimeout = %v, want %v (TOML must win over default)", cfg.RunTimeout, 7*time.Minute)
	}
	if cfg.PiModels["default"] != "model-from-toml" {
		t.Errorf("PiModels[default] = %q, want %q (nested TOML table must flatten to map)", cfg.PiModels["default"], "model-from-toml")
	}
	if cfg.SeerrWebhookPath != "/webhooks/seerr" {
		t.Errorf("SeerrWebhookPath = %q, want default %q", cfg.SeerrWebhookPath, "/webhooks/seerr")
	}
	if cfg.BotPublicName != "blitzcrank" {
		t.Errorf("BotPublicName = %q, want default %q", cfg.BotPublicName, "blitzcrank")
	}
}

func TestConfigExampleParses(t *testing.T) {
	var cfg Config
	if err := applyDefaults(&cfg); err != nil {
		t.Fatalf("applyDefaults() error = %v", err)
	}
	if err := applyTOMLFile(&cfg, filepath.Join("..", "..", "config.example.toml")); err != nil {
		t.Fatalf("applyTOMLFile(config.example.toml) error = %v", err)
	}
	if cfg.DiscordTriageTimeout != 8*time.Second || cfg.ReviewTimeout != 15*time.Second || cfg.ConfirmationTTL != 15*time.Minute {
		t.Fatalf("example timeouts = Discord triage %v, review %v, confirmation %v", cfg.DiscordTriageTimeout, cfg.ReviewTimeout, cfg.ConfirmationTTL)
	}
	if cfg.PiModels["discord_triage"] != "" {
		t.Fatalf("example discord_triage model = %q, want empty placeholder", cfg.PiModels["discord_triage"])
	}
}

func TestLoadMissingTOMLIsNotAnError(t *testing.T) {
	sanitizeConfigEnv(t, "PI_COMMAND")

	missing := filepath.Join(t.TempDir(), "does-not-exist.toml")
	t.Setenv("BLITZCRANK_CONFIG", missing)

	cfg, err := load(filepath.Join(t.TempDir(), "no-dotenv"), false)
	if err != nil {
		t.Fatalf("load() error = %v, want nil (missing TOML file must not be an error)", err)
	}
	if cfg.PiCommand != "pi" {
		t.Errorf("PiCommand = %q, want default %q", cfg.PiCommand, "pi")
	}
}

func TestLoadRelaxedAllowsMutationWorkflowWithoutReviewModel(t *testing.T) {
	sanitizeConfigEnv(t, "PI_MODELS", "BLITZCRANK_HTTP_LISTEN_ADDR", "SEERR_API_KEY")

	dir := t.TempDir()
	tomlPath := filepath.Join(dir, "blitzcrank.toml")
	if err := os.WriteFile(tomlPath, []byte(`
[web]
listen_addr = "127.0.0.1:8080"
[seerr]
base_url = "http://seerr.local"
api_key = "key"
mutation_budget = 1
[pi.models]
default = "working-model"
`), 0o600); err != nil {
		t.Fatalf("write TOML config: %v", err)
	}
	t.Setenv("BLITZCRANK_CONFIG", tomlPath)

	cfg, err := LoadRelaxed(filepath.Join(t.TempDir(), "no-dotenv"))
	if err != nil {
		t.Fatalf("LoadRelaxed() error = %v", err)
	}
	if got := cfg.PiModelFor("mutation_review"); got != "" {
		t.Fatalf("PiModelFor(mutation_review) = %q, want no fallback", got)
	}
}

func TestLoadRevisitConfig(t *testing.T) {
	tests := []struct {
		name        string
		toml        string
		env         map[string]string
		wantEnabled bool
		wantMax     int
	}{
		{
			name:        "defaults disable revisits with max five",
			wantEnabled: false,
			wantMax:     5,
		},
		{
			name: "toml overrides revisit settings",
			toml: `
[seerr]
revisits_enabled = true
revisit_max = 4
`,
			wantEnabled: true,
			wantMax:     4,
		},
		{
			name: "env overrides revisit settings",
			toml: `
[seerr]
revisits_enabled = false
revisit_max = 3
`,
			env: map[string]string{
				"SEERR_REVISITS_ENABLED": "true",
				"SEERR_REVISIT_MAX":      "7",
			},
			wantEnabled: true,
			wantMax:     7,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sanitizeConfigEnv(t, "SEERR_REVISITS_ENABLED", "SEERR_REVISIT_MAX")
			dir := t.TempDir()
			tomlPath := filepath.Join(dir, "blitzcrank.toml")
			if tt.toml != "" {
				if err := os.WriteFile(tomlPath, []byte(tt.toml), 0o600); err != nil {
					t.Fatalf("write toml config: %v", err)
				}
			} else {
				tomlPath = filepath.Join(dir, "missing.toml")
			}
			t.Setenv("BLITZCRANK_CONFIG", tomlPath)
			for key, value := range tt.env {
				t.Setenv(key, value)
			}

			cfg, err := load(filepath.Join(t.TempDir(), "no-dotenv"), false)
			if err != nil {
				t.Fatalf("load() error = %v", err)
			}
			if cfg.SeerrRevisitsEnabled != tt.wantEnabled {
				t.Fatalf("SeerrRevisitsEnabled = %v, want %v", cfg.SeerrRevisitsEnabled, tt.wantEnabled)
			}
			if cfg.SeerrRevisitMax != tt.wantMax {
				t.Fatalf("SeerrRevisitMax = %d, want %d", cfg.SeerrRevisitMax, tt.wantMax)
			}
		})
	}
}

func TestLoadDiscordAndReviewConfig(t *testing.T) {
	sanitizeConfigEnv(t,
		"DISCORD_WATCHED_CHANNEL_IDS",
		"DISCORD_TRIAGE_TIMEOUT",
		"DISCORD_RUN_TIMEOUT",
		"DISCORD_DEBOUNCE",
		"DISCORD_THREAD_INACTIVITY",
		"DISCORD_RETENTION",
		"DISCORD_MUTATION_BUDGET",
		"REVIEW_TIMEOUT",
		"REVIEW_CAPACITY",
		"CONFIRMATION_TTL",
		"SEERR_MUTATION_BUDGET",
		"AUTOMATION_MUTATION_BUDGET",
	)

	dir := t.TempDir()
	tomlPath := filepath.Join(dir, "blitzcrank.toml")
	if err := os.WriteFile(tomlPath, []byte(`
[discord]
watched_channel_ids = ["100", " 200 ", "100"]
triage_timeout = "6s"
run_timeout = "4m"
debounce = "500ms"
thread_inactivity = "12h"
retention = "240h"
mutation_budget = 2

[seerr]
mutation_budget = 4

[runtime]
review_timeout = "11s"
review_capacity = 2
automation_mutation_budget = 4

[review]
confirmation_ttl = "10m"
`), 0o600); err != nil {
		t.Fatalf("write toml config: %v", err)
	}
	t.Setenv("BLITZCRANK_CONFIG", tomlPath)
	t.Setenv("DISCORD_TRIAGE_TIMEOUT", "7s")
	t.Setenv("REVIEW_CAPACITY", "3")

	cfg, err := load(filepath.Join(t.TempDir(), "no-dotenv"), false)
	if err != nil {
		t.Fatalf("load() error = %v", err)
	}
	if got, want := strings.Join(cfg.DiscordWatchedChannelIDs, ","), "100,200"; got != want {
		t.Fatalf("DiscordWatchedChannelIDs = %q, want %q", got, want)
	}
	if cfg.DiscordTriageTimeout != 7*time.Second || cfg.DiscordRunTimeout != 4*time.Minute || cfg.DiscordDebounce != 500*time.Millisecond {
		t.Fatalf("Discord timeouts = triage %v, run %v, debounce %v", cfg.DiscordTriageTimeout, cfg.DiscordRunTimeout, cfg.DiscordDebounce)
	}
	if cfg.DiscordThreadInactivity != 12*time.Hour || cfg.DiscordRetention != 240*time.Hour {
		t.Fatalf("Discord retention = inactivity %v, retention %v", cfg.DiscordThreadInactivity, cfg.DiscordRetention)
	}
	if cfg.DiscordMutationBudget != 2 || cfg.SeerrMutationBudget != 4 || cfg.AutomationMutationBudget != 4 {
		t.Fatalf("mutation budgets = Discord %d, Seerr %d, automation %d", cfg.DiscordMutationBudget, cfg.SeerrMutationBudget, cfg.AutomationMutationBudget)
	}
	if cfg.ReviewTimeout != 11*time.Second || cfg.ReviewCapacity != 3 || cfg.ConfirmationTTL != 10*time.Minute {
		t.Fatalf("review config = timeout %v, capacity %d, confirmation TTL %v", cfg.ReviewTimeout, cfg.ReviewCapacity, cfg.ConfirmationTTL)
	}
}

func TestDiscordAndReviewConfigDefaults(t *testing.T) {
	var cfg Config
	if err := applyDefaults(&cfg); err != nil {
		t.Fatalf("applyDefaults() error = %v", err)
	}
	if cfg.DiscordTriageTimeout != 8*time.Second || cfg.DiscordDebounce != 750*time.Millisecond {
		t.Fatalf("Discord defaults = triage %v, debounce %v", cfg.DiscordTriageTimeout, cfg.DiscordDebounce)
	}
	if cfg.DiscordRunTimeout != 0 {
		t.Fatalf("DiscordRunTimeout = %v, want zero to inherit runtime.run_timeout", cfg.DiscordRunTimeout)
	}
	if cfg.DiscordThreadInactivity != 24*time.Hour || cfg.DiscordRetention != 30*24*time.Hour {
		t.Fatalf("Discord lifecycle defaults = inactivity %v, retention %v", cfg.DiscordThreadInactivity, cfg.DiscordRetention)
	}
	if cfg.ReviewTimeout != 15*time.Second || cfg.ReviewCapacity != 1 || cfg.ConfirmationTTL != 15*time.Minute {
		t.Fatalf("review defaults = timeout %v, capacity %d, confirmation TTL %v", cfg.ReviewTimeout, cfg.ReviewCapacity, cfg.ConfirmationTTL)
	}
	if cfg.DiscordMutationBudget != 3 || cfg.SeerrMutationBudget != 5 || cfg.AutomationMutationBudget != 5 {
		t.Fatalf("mutation budget defaults = Discord %d, Seerr %d, automation %d", cfg.DiscordMutationBudget, cfg.SeerrMutationBudget, cfg.AutomationMutationBudget)
	}
}

func TestLoadRejectsBadDuration(t *testing.T) {
	sanitizeConfigEnv(t, "AGENT_RUN_TIMEOUT")

	dir := t.TempDir()
	tomlPath := filepath.Join(dir, "blitzcrank.toml")
	tomlContents := `
[runtime]
run_timeout = "0s"
`
	if err := os.WriteFile(tomlPath, []byte(tomlContents), 0o600); err != nil {
		t.Fatalf("write toml config: %v", err)
	}
	t.Setenv("BLITZCRANK_CONFIG", tomlPath)

	_, err := load(filepath.Join(t.TempDir(), "no-dotenv"), false)
	if err == nil {
		t.Fatal("load() error = nil, want an error mentioning duration")
	}
	if !strings.Contains(err.Error(), "duration") {
		t.Fatalf("load() error = %q, want it to mention %q", err.Error(), "duration")
	}
}

func TestValidateStrictConfig(t *testing.T) {
	tests := []struct {
		name    string
		cfg     Config
		wantErr bool
	}{
		{
			name: "webhook enabled without base url or api key",
			cfg: Config{
				SeerrWebhookListenAddr: ":8080",
				SeerrWebhookPath:       "/x",
			},
			wantErr: true,
		},
		{
			name: "webhook enabled with base url, api key, and valid path",
			cfg: Config{
				SeerrWebhookListenAddr: ":8080",
				SeerrBaseURL:           "http://seerr.local",
				SeerrAPIKey:            "key",
				SeerrWebhookPath:       "/x",
			},
			wantErr: false,
		},
		{
			name: "web listen address enables webhook validation",
			cfg: Config{
				HTTPListenAddr:   ":8080",
				SeerrWebhookPath: "/x",
			},
			wantErr: true,
		},
		{
			name: "webhook path missing leading slash",
			cfg: Config{
				SeerrWebhookListenAddr: ":8080",
				SeerrBaseURL:           "http://seerr.local",
				SeerrAPIKey:            "key",
				SeerrWebhookPath:       "x",
			},
			wantErr: true,
		},
		{
			name:    "webhook disabled requires nothing",
			cfg:     Config{},
			wantErr: false,
		},
		{
			name: "watched Discord channels require token",
			cfg: Config{
				DiscordWatchedChannelIDs: []string{"123"},
				PiModels:                 map[string]string{"discord_triage": "fast-model"},
			},
			wantErr: true,
		},
		{
			name: "watched Discord channels require dedicated triage model",
			cfg: Config{
				DiscordWatchedChannelIDs: []string{"123"},
				DiscordToken:             "token",
				PiModels:                 map[string]string{"default": "default-model"},
			},
			wantErr: true,
		},
		{
			name: "watched Discord channels accept dedicated triage configuration",
			cfg: Config{
				DiscordWatchedChannelIDs: []string{"123"},
				DiscordToken:             "token",
				PiModels:                 map[string]string{"discord_triage": "fast-model"},
			},
			wantErr: false,
		},
		{
			name: "mutation-capable Discord requires dedicated review model",
			cfg: Config{
				DiscordWatchedChannelIDs: []string{"123"},
				DiscordToken:             "token",
				DiscordMutationBudget:    1,
				PiModels:                 map[string]string{"discord_triage": "fast-model", "default": "working-model"},
			},
			wantErr: true,
		},
		{
			name: "read-only Discord does not require review model",
			cfg: Config{
				DiscordWatchedChannelIDs: []string{"123"},
				DiscordToken:             "token",
				PiModels:                 map[string]string{"discord_triage": "fast-model"},
			},
			wantErr: false,
		},
		{
			name: "mutation-capable Seerr requires dedicated review model",
			cfg: Config{
				HTTPListenAddr:      ":8080",
				SeerrWebhookPath:    "/x",
				SeerrBaseURL:        "http://seerr.local",
				SeerrAPIKey:         "key",
				SeerrMutationBudget: 1,
				PiModels:            map[string]string{"default": "working-model"},
			},
			wantErr: true,
		},
		{
			name: "mutation-capable automation requires dedicated review model",
			cfg: Config{
				AutomationsEnabled:       true,
				AutomationMutationBudget: 1,
				PiModels:                 map[string]string{"default": "working-model"},
			},
			wantErr: true,
		},
		{
			name: "enabled mutation workflows accept dedicated review model",
			cfg: Config{
				HTTPListenAddr:           ":8080",
				SeerrWebhookPath:         "/x",
				SeerrBaseURL:             "http://seerr.local",
				SeerrAPIKey:              "key",
				SeerrMutationBudget:      1,
				AutomationsEnabled:       true,
				AutomationMutationBudget: 1,
				PiModels:                 map[string]string{"review": "review-model"},
			},
			wantErr: false,
		},
		{
			name: "negative revisit max is rejected",
			cfg: Config{
				SeerrRevisitMax: -1,
			},
			wantErr: true,
		},
		{
			name: "negative Discord mutation budget is rejected",
			cfg: Config{
				DiscordMutationBudget: -1,
			},
			wantErr: true,
		},
		{
			name: "excessive Discord mutation budget is rejected",
			cfg: Config{
				DiscordMutationBudget: 4,
			},
			wantErr: true,
		},
		{
			name: "negative Seerr mutation budget is rejected",
			cfg: Config{
				SeerrMutationBudget: -1,
			},
			wantErr: true,
		},
		{
			name: "negative automation mutation budget is rejected",
			cfg: Config{
				AutomationMutationBudget: -1,
			},
			wantErr: true,
		},
		{
			name: "excessive automation mutation budget is rejected",
			cfg: Config{
				AutomationMutationBudget: 11,
			},
			wantErr: true,
		},
		{
			name: "negative review capacity is rejected",
			cfg: Config{
				ReviewCapacity: -1,
			},
			wantErr: true,
		},
		{
			name: "zero review capacity is rejected when review is configured",
			cfg: Config{
				ReviewTimeout:  15 * time.Second,
				ReviewCapacity: 0,
			},
			wantErr: true,
		},
		{
			name: "negative Discord duration is rejected",
			cfg: Config{
				DiscordDebounce: -time.Second,
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateStrictConfig(tt.cfg)
			if tt.wantErr && err == nil {
				t.Fatal("validateStrictConfig() error = nil, want error")
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("validateStrictConfig() unexpected error: %v", err)
			}
		})
	}
}

func TestPiModelFor(t *testing.T) {
	tests := []struct {
		name   string
		models map[string]string
		source string
		want   string
	}{
		{
			name:   "source-specific entry wins over default",
			models: map[string]string{"automation": "m-auto", "default": "m-def"},
			source: "automation",
			want:   "m-auto",
		},
		{
			name:   "source with automation prefix matches automation key",
			models: map[string]string{"automation": "m-auto", "default": "m-def"},
			source: "automation-daily-health-check",
			want:   "m-auto",
		},
		{
			name:   "unknown source falls back to default",
			models: map[string]string{"default": "m-def"},
			source: "unknown-source",
			want:   "m-def",
		},
		{
			name:   "Discord triage uses isolated lightweight model",
			models: map[string]string{"discord_triage": "m-fast", "discord": "m-discord", "default": "m-def"},
			source: "discord_triage",
			want:   "m-fast",
		},
		{
			name:   "Discord direct uses Discord model",
			models: map[string]string{"discord": "m-discord", "default": "m-def"},
			source: "discord_direct",
			want:   "m-discord",
		},
		{
			name:   "Discord thread uses Discord model",
			models: map[string]string{"discord": "m-discord", "default": "m-def"},
			source: "discord_thread",
			want:   "m-discord",
		},
		{
			name:   "review uses independent review model",
			models: map[string]string{"review": "m-review", "default": "m-def"},
			source: "mutation_review",
			want:   "m-review",
		},
		{
			name:   "review never falls back to default model",
			models: map[string]string{"default": "m-def"},
			source: "mutation_review",
			want:   "",
		},
		{
			name:   "empty map yields empty string",
			models: map[string]string{},
			source: "default",
			want:   "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := Config{PiModels: tt.models}
			if got := cfg.PiModelFor(tt.source); got != tt.want {
				t.Fatalf("PiModelFor(%q) = %q, want %q", tt.source, got, tt.want)
			}
		})
	}
}
