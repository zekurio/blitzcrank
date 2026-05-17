package config

import (
	"os"
	"strings"
	"time"
)

type Config struct {
	DiscordToken                 string
	DiscordGuildID               string
	InstanceOwnerID              string
	DiscordSeerrUserMap          map[string]string
	AgentDiscordChannelID        string
	DiscordTriageThreshold       float64
	DiscordThreadArchiveMinutes  int
	DiscordContextRecentMessages int

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

	Provider                 string
	CodexAuthProfile         string
	CodexAuthStore           string
	CodexBaseURL             string
	CodexServiceTier         string
	OpenAIAPIKey             string
	OpenAIBaseURL            string
	OpenRouterAPIKey         string
	OpenRouterBaseURL        string
	OpenRouterReferer        string
	OpenRouterTitle          string
	Model                    string
	ReasoningEffort          string
	RuntimeProfiles          map[string]RuntimeProfile
	RuntimeDefaultConfigPath string
	RuntimeConfigPath        string
	SkillsDirectory          string
	AutomationsDirectory     string
	ThreadsDirectory         string
	MaxToolIterations        int
	RunTimeout               time.Duration
	AutomationsEnabled       bool
	AutomationsExtraDirs     []string
	DatabasePath             string

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
	_, runtimeConfigPathSet := os.LookupEnv("RUNTIME_CONFIG_PATH")

	cfg := Config{
		DiscordToken:                 os.Getenv("DISCORD_TOKEN"),
		DiscordGuildID:               os.Getenv("DISCORD_GUILD_ID"),
		InstanceOwnerID:              os.Getenv("INSTANCE_OWNER_DISCORD_ID"),
		DiscordSeerrUserMap:          jsonMapEnv("DISCORD_SEERR_USER_MAP"),
		AgentDiscordChannelID:        os.Getenv("DISCORD_CHANNEL_ID"),
		DiscordTriageThreshold:       floatEnv("DISCORD_TRIAGE_THRESHOLD", 0.75),
		DiscordThreadArchiveMinutes:  intEnv("DISCORD_THREAD_ARCHIVE_MINUTES", 1440),
		DiscordContextRecentMessages: intEnv("DISCORD_CONTEXT_RECENT_MESSAGES", 12),
		SeerrWebhookListenAddr:       strings.TrimSpace(os.Getenv("SEERR_WEBHOOK_LISTEN_ADDR")),
		SeerrWebhookPath:             getenv("SEERR_WEBHOOK_PATH", "/webhooks/seerr"),
		SeerrWebhookSecret:           os.Getenv("SEERR_WEBHOOK_SECRET"),
		SeerrBaseURL:                 os.Getenv("SEERR_BASE_URL"),
		SeerrAPIKey:                  os.Getenv("SEERR_API_KEY"),
		JellyfinBaseURL:              os.Getenv("JELLYFIN_BASE_URL"),
		JellyfinAPIKey:               os.Getenv("JELLYFIN_API_KEY"),
		SonarrBaseURL:                os.Getenv("SONARR_BASE_URL"),
		SonarrAPIKey:                 os.Getenv("SONARR_API_KEY"),
		RadarrBaseURL:                os.Getenv("RADARR_BASE_URL"),
		RadarrAPIKey:                 os.Getenv("RADARR_API_KEY"),
		SabnzbdBaseURL:               os.Getenv("SABNZBD_BASE_URL"),
		SabnzbdAPIKey:                os.Getenv("SABNZBD_API_KEY"),
		FSAllowedRoots:               listEnv("FS_TOOL_ALLOWED_ROOTS"),
		ExaBaseURL:                   getenv("EXA_BASE_URL", "https://api.exa.ai"),
		ExaAPIKey:                    os.Getenv("EXA_API_KEY"),
		CodexAuthProfile:             getenv("CODEX_AUTH_PROFILE", "default"),
		CodexAuthStore:               getenv("CODEX_AUTH_STORE", ""),
		CodexBaseURL:                 getenv("CODEX_BASE_URL", "https://chatgpt.com/backend-api/codex"),
		CodexServiceTier:             codexServiceTierFromFastEnv("CODEX_FAST_MODE", "standard"),
		OpenAIAPIKey:                 os.Getenv("OPENAI_API_KEY"),
		OpenAIBaseURL:                getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
		OpenRouterAPIKey:             os.Getenv("OPENROUTER_API_KEY"),
		OpenRouterBaseURL:            getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
		OpenRouterReferer:            os.Getenv("OPENROUTER_HTTP_REFERER"),
		OpenRouterTitle:              getenv("OPENROUTER_X_TITLE", "Blitzcrank"),
		RuntimeDefaultConfigPath:     os.Getenv("RUNTIME_DEFAULT_CONFIG_PATH"),
		RuntimeConfigPath:            getenv("RUNTIME_CONFIG_PATH", "./runtime-config.json"),
		SkillsDirectory:              getenv("SKILLS_DIR", "skills"),
		AutomationsDirectory:         getenv("AUTOMATIONS_DIR", "automations"),
		ThreadsDirectory:             getenv("AGENT_THREADS_DIR", "threads"),
		MaxToolIterations:            intEnv("AGENT_MAX_TOOL_ITERATIONS", 15),
		RunTimeout:                   durationEnv("AGENT_RUN_TIMEOUT", 5*time.Minute),
		AutomationsEnabled:           boolEnvFallback("AUTOMATIONS_ENABLED", "CRON_ENABLED", false),
		AutomationsExtraDirs:         listEnv("AUTOMATIONS_EXTRA_DIRS"),
		DatabasePath:                 getenv("DATABASE_PATH", "./blitzcrank.sqlite"),
		SeerrBotUserID:               os.Getenv("SEERR_BOT_USER_ID"),
		SeerrBotDisplayName:          getenv("SEERR_BOT_DISPLAY_NAME", "Blitzcrank"),
		BotPublicName:                getenv("BOT_PUBLIC_NAME", "Blitzcrank"),
		Timezone:                     getenv("TIMEZONE", "UTC"),
	}
	cfg.RuntimeProfiles = runtimeProfiles(cfg)
	if runtimeConfigPathSet {
		seed := RuntimeFileFromConfig(cfg)
		if strings.TrimSpace(cfg.RuntimeDefaultConfigPath) != "" {
			seed = RuntimeFile{}
		}
		if err := SeedRuntimeConfigFile(cfg.RuntimeConfigPath, seed); err != nil {
			return cfg, err
		}
	}
	if err := ApplyRuntimeConfigFile(&cfg); err != nil {
		return cfg, err
	}

	if !validate {
		return cfg, nil
	}
	if err := validateStrictConfig(cfg); err != nil {
		return cfg, err
	}
	return cfg, nil
}
