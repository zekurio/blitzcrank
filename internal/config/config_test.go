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
			name: "negative revisit max is rejected",
			cfg: Config{
				SeerrRevisitMax: -1,
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
