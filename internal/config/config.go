package config

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	DiscordToken          string
	DiscordGuildID        string
	InstanceOwnerID       string
	AgentDiscordChannelID string

	SeerrWebhookListenAddr string
	SeerrWebhookPath       string
	SeerrWebhookSecret     string
	SeerrBaseURL           string
	SeerrAPIKey            string

	JellyfinBaseURL string
	JellyfinAPIKey  string
	SonarrBaseURL   string
	SonarrAPIKey    string
	RadarrBaseURL   string
	RadarrAPIKey    string
	SabnzbdBaseURL  string
	SabnzbdAPIKey   string
	FSAllowedRoots  []string
	ExaBaseURL      string
	ExaAPIKey       string

	LLMProvider       string
	CodexAuthProfile  string
	CodexAuthStore    string
	CodexBaseURL      string
	CodexServiceTier  string
	OpenAIAPIKey      string
	OpenAIBaseURL     string
	Model             string
	ReasoningEffort   string
	OpenAIReferer     string
	OpenAITitle       string
	SystemPromptPath  string
	SkillsDirectory   string
	ThreadsDirectory  string
	MaxToolIterations int
	RunTimeout        time.Duration
	CronEnabled       bool
	AutomationTasks   []string
	AutomationsDir    string
	DatabasePath      string

	SeerrBotUserID      string
	SeerrBotDisplayName string

	BotPublicName string
	Timezone      string
}

func Load(dotenvPath string) (Config, error) {
	return load(dotenvPath, true)
}

func LoadRelaxed(dotenvPath string) (Config, error) {
	return load(dotenvPath, false)
}

func load(dotenvPath string, validate bool) (Config, error) {
	_ = loadDotenv(dotenvPath)

	cfg := Config{
		DiscordToken:           os.Getenv("DISCORD_TOKEN"),
		DiscordGuildID:         os.Getenv("DISCORD_GUILD_ID"),
		InstanceOwnerID:        os.Getenv("INSTANCE_OWNER_DISCORD_ID"),
		AgentDiscordChannelID:  os.Getenv("AGENT_DISCORD_CHANNEL_ID"),
		SeerrWebhookListenAddr: getenv("SEERR_WEBHOOK_LISTEN_ADDR", "127.0.0.1:8080"),
		SeerrWebhookPath:       getenv("SEERR_WEBHOOK_PATH", "/webhooks/seerr"),
		SeerrWebhookSecret:     os.Getenv("SEERR_WEBHOOK_SECRET"),
		SeerrBaseURL:           os.Getenv("SEERR_BASE_URL"),
		SeerrAPIKey:            os.Getenv("SEERR_API_KEY"),
		JellyfinBaseURL:        os.Getenv("JELLYFIN_BASE_URL"),
		JellyfinAPIKey:         os.Getenv("JELLYFIN_API_KEY"),
		SonarrBaseURL:          os.Getenv("SONARR_BASE_URL"),
		SonarrAPIKey:           os.Getenv("SONARR_API_KEY"),
		RadarrBaseURL:          os.Getenv("RADARR_BASE_URL"),
		RadarrAPIKey:           os.Getenv("RADARR_API_KEY"),
		SabnzbdBaseURL:         os.Getenv("SABNZBD_BASE_URL"),
		SabnzbdAPIKey:          os.Getenv("SABNZBD_API_KEY"),
		FSAllowedRoots:         listEnv("FS_TOOL_ALLOWED_ROOTS"),
		ExaBaseURL:             getenv("EXA_BASE_URL", "https://api.exa.ai"),
		ExaAPIKey:              os.Getenv("EXA_API_KEY"),
		LLMProvider:            getenv("LLM_PROVIDER", "openai-compatible"),
		CodexAuthProfile:       getenv("CODEX_AUTH_PROFILE", "default"),
		CodexAuthStore:         getenv("CODEX_AUTH_STORE", ""),
		CodexBaseURL:           getenv("CODEX_BASE_URL", "https://chatgpt.com/backend-api/codex"),
		CodexServiceTier:       getenv("CODEX_SERVICE_TIER", "standard"),
		OpenAIAPIKey:           firstEnv("OPENAI_API_KEY", "OPENROUTER_API_KEY"),
		OpenAIBaseURL:          getenv("OPENAI_BASE_URL", getenv("OPENROUTER_BASE_URL", "https://api.openai.com/v1")),
		Model:                  getenv("MODEL", "gpt-5.5"),
		ReasoningEffort:        os.Getenv("REASONING_EFFORT"),
		OpenAIReferer:          os.Getenv("OPENROUTER_HTTP_REFERER"),
		OpenAITitle:            getenv("OPENROUTER_X_TITLE", "Blitzcrank"),
		SystemPromptPath:       getenv("AGENT_SYSTEM_PROMPT", "prompts/system.md"),
		SkillsDirectory:        getenv("AGENT_SKILLS_DIR", "skills"),
		ThreadsDirectory:       getenv("AGENT_THREADS_DIR", "threads"),
		MaxToolIterations:      intEnv("AGENT_MAX_TOOL_ITERATIONS", 8),
		RunTimeout:             durationEnv("AGENT_RUN_TIMEOUT", 5*time.Minute),
		CronEnabled:            boolEnv("CRON_ENABLED", false),
		AutomationTasks:        listEnv("AUTOMATION_TASKS"),
		AutomationsDir:         getenv("AUTOMATIONS_DIR", "automations"),
		DatabasePath:           getenv("DATABASE_PATH", "./blitzcrank.sqlite"),
		SeerrBotUserID:         os.Getenv("SEERR_BOT_USER_ID"),
		SeerrBotDisplayName:    getenv("SEERR_BOT_DISPLAY_NAME", "Blitzcrank"),
		BotPublicName:          getenv("BOT_PUBLIC_NAME", "Blitzcrank"),
		Timezone:               getenv("TIMEZONE", "UTC"),
	}

	if !validate {
		return cfg, nil
	}

	if cfg.LLMProvider != "codex-oauth" && cfg.LLMProvider != "openai-codex" && cfg.LLMProvider != "codex" && cfg.OpenAIAPIKey == "" {
		return cfg, errors.New("OPENAI_API_KEY or OPENROUTER_API_KEY is required")
	}
	if cfg.Model == "" {
		return cfg, errors.New("MODEL is required")
	}
	if cfg.SeerrWebhookListenAddr != "" && (cfg.SeerrBaseURL == "" || cfg.SeerrAPIKey == "") {
		return cfg, errors.New("SEERR_BASE_URL and SEERR_API_KEY are required when the Seerr webhook server is enabled")
	}
	if cfg.SeerrWebhookPath == "" || !strings.HasPrefix(cfg.SeerrWebhookPath, "/") {
		return cfg, fmt.Errorf("SEERR_WEBHOOK_PATH must start with /")
	}
	return cfg, nil
}

func loadDotenv(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") || !strings.Contains(line, "=") {
			continue
		}
		key, value, _ := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		if key != "" && os.Getenv(key) == "" {
			_ = os.Setenv(key, value)
		}
	}
	return scanner.Err()
}

func getenv(key, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func firstEnv(keys ...string) string {
	for _, key := range keys {
		if value := os.Getenv(key); value != "" {
			return value
		}
	}
	return ""
}

func listEnv(key string) []string {
	raw := os.Getenv(key)
	if raw == "" {
		return nil
	}
	var values []string
	for _, value := range strings.Split(raw, ",") {
		value = strings.TrimSpace(value)
		if value != "" {
			values = append(values, value)
		}
	}
	return values
}

func intEnv(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 1 {
		return fallback
	}
	return parsed
}

func durationEnv(key string, fallback time.Duration) time.Duration {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func boolEnv(key string, fallback bool) bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	if value == "" {
		return fallback
	}
	switch value {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}
