package config

import (
	"strings"
	"time"
)

type Config struct {
	DiscordToken                 string            `env:"DISCORD_TOKEN" toml:"discord.token"`
	DiscordGuildID               string            `env:"DISCORD_GUILD_ID" toml:"discord.guild_id"`
	InstanceOwnerID              string            `env:"INSTANCE_OWNER_DISCORD_ID" toml:"discord.owner_id"`
	DiscordSeerrUserMap          map[string]string `env:"DISCORD_SEERR_USER_MAP" toml:"discord.seerr_user_map"`
	AgentDiscordChannelID        string            `env:"DISCORD_CHANNEL_ID" toml:"discord.channel_id"`
	DiscordTriageThreshold       float64           `env:"DISCORD_TRIAGE_THRESHOLD" toml:"discord.triage_threshold" default:"0.75"`
	DiscordThreadArchiveMinutes  int               `env:"DISCORD_THREAD_ARCHIVE_MINUTES" toml:"discord.thread_archive_minutes" default:"1440"`
	DiscordContextRecentMessages int               `env:"DISCORD_CONTEXT_RECENT_MESSAGES" toml:"discord.context_recent_messages" default:"12"`

	SeerrWebhookListenAddr string `env:"SEERR_WEBHOOK_LISTEN_ADDR" toml:"seerr.webhook_listen_addr"`
	SeerrWebhookPath       string `env:"SEERR_WEBHOOK_PATH" toml:"seerr.webhook_path" default:"/webhooks/seerr"`
	SeerrWebhookSecret     string `env:"SEERR_WEBHOOK_SECRET" toml:"seerr.webhook_secret"`
	SeerrBaseURL           string `env:"SEERR_BASE_URL" toml:"seerr.base_url"`
	SeerrAPIKey            string `env:"SEERR_API_KEY" toml:"seerr.api_key"`

	JellyfinBaseURL string   `env:"JELLYFIN_BASE_URL" toml:"jellyfin.base_url"`
	JellyfinAPIKey  string   `env:"JELLYFIN_API_KEY" toml:"jellyfin.api_key"`
	SonarrBaseURL   string   `env:"SONARR_BASE_URL" toml:"sonarr.base_url"`
	SonarrAPIKey    string   `env:"SONARR_API_KEY" toml:"sonarr.api_key"`
	RadarrBaseURL   string   `env:"RADARR_BASE_URL" toml:"radarr.base_url"`
	RadarrAPIKey    string   `env:"RADARR_API_KEY" toml:"radarr.api_key"`
	SabnzbdBaseURL  string   `env:"SABNZBD_BASE_URL" toml:"sabnzbd.base_url"`
	SabnzbdAPIKey   string   `env:"SABNZBD_API_KEY" toml:"sabnzbd.api_key"`
	FSAllowedRoots  []string `env:"FS_TOOL_ALLOWED_ROOTS" toml:"filesystem.allowed_roots"`
	ExaBaseURL      string   `env:"EXA_BASE_URL" toml:"exa.base_url" default:"https://api.exa.ai"`
	ExaAPIKey       string   `env:"EXA_API_KEY" toml:"exa.api_key"`

	Provider             string `env:"AGENT_DEFAULT_PROVIDER" toml:"runtime.profiles.default.provider" default:"openai-compatible"`
	CodexAuthProfile     string `env:"CODEX_AUTH_PROFILE" toml:"llm.codex.auth_profile" default:"default"`
	CodexAuthStore       string `env:"CODEX_AUTH_STORE" toml:"llm.codex.auth_store"`
	CodexBaseURL         string `env:"CODEX_BASE_URL" toml:"llm.codex.base_url" default:"https://chatgpt.com/backend-api/codex"`
	CodexServiceTier     string `env:"CODEX_SERVICE_TIER" toml:"llm.codex.service_tier" default:"standard"`
	OpenAIAPIKey         string `env:"OPENAI_API_KEY" toml:"llm.openai.api_key"`
	OpenAIBaseURL        string `env:"OPENAI_BASE_URL" toml:"llm.openai.base_url" default:"https://api.openai.com/v1"`
	OpenRouterAPIKey     string `env:"OPENROUTER_API_KEY" toml:"llm.openrouter.api_key"`
	OpenRouterBaseURL    string `env:"OPENROUTER_BASE_URL" toml:"llm.openrouter.base_url" default:"https://openrouter.ai/api/v1"`
	OpenRouterReferer    string `env:"OPENROUTER_HTTP_REFERER" toml:"llm.openrouter.http_referer"`
	OpenRouterTitle      string `env:"OPENROUTER_X_TITLE" toml:"llm.openrouter.title" default:"Blitzcrank"`
	Model                string `env:"AGENT_DEFAULT_MODEL" toml:"runtime.profiles.default.model" default:"gpt-5.5"`
	ReasoningEffort      string `env:"AGENT_DEFAULT_REASONING_EFFORT" toml:"runtime.profiles.default.reasoning_effort"`
	RuntimeProfiles      map[string]RuntimeProfile
	ConfigPath           string        `env:"BLITZCRANK_CONFIG" default:"./blitzcrank.toml"`
	SkillsDirectory      string        `env:"SKILLS_DIR" toml:"runtime.skills_dir" default:"skills"`
	AutomationsDirectory string        `env:"AUTOMATIONS_DIR" toml:"runtime.automations_dir" default:"automations"`
	ThreadsDirectory     string        `env:"AGENT_THREADS_DIR" toml:"runtime.threads_dir" default:"threads"`
	MaxToolIterations    int           `env:"AGENT_MAX_TOOL_ITERATIONS" toml:"runtime.max_tool_iterations" default:"15"`
	RunTimeout           time.Duration `env:"AGENT_RUN_TIMEOUT" toml:"runtime.run_timeout" default:"5m"`
	AutomationsEnabled   bool          `env:"AUTOMATIONS_ENABLED" toml:"runtime.automations_enabled"`
	AutomationsExtraDirs []string      `env:"AUTOMATIONS_EXTRA_DIRS" toml:"runtime.automations_extra_dirs"`
	DatabasePath         string        `env:"DATABASE_PATH" toml:"storage.database_path" default:"./blitzcrank.sqlite"`

	SeerrBotUserID      string `env:"SEERR_BOT_USER_ID" toml:"seerr.bot_user_id"`
	SeerrBotDisplayName string `env:"SEERR_BOT_DISPLAY_NAME" toml:"seerr.bot_display_name" default:"Blitzcrank"`

	BotPublicName string `env:"BOT_PUBLIC_NAME" toml:"bot.public_name" default:"Blitzcrank"`
	Timezone      string `env:"TIMEZONE" toml:"runtime.timezone" default:"UTC"`
}

func Load(dotenvPath string) (Config, error) {
	return load(dotenvPath, true)
}

func LoadRelaxed(dotenvPath string) (Config, error) {
	return load(dotenvPath, false)
}

func load(dotenvPath string, validate bool) (Config, error) {
	var cfg Config
	if err := applyDefaults(&cfg); err != nil {
		return cfg, err
	}
	_ = loadDotenv(dotenvPath)
	if err := applyEnv(&cfg); err != nil {
		return cfg, err
	}
	if strings.TrimSpace(cfg.ConfigPath) != "" {
		if err := applyTOMLFile(&cfg, cfg.ConfigPath); err != nil {
			return cfg, err
		}
	}
	tomlProfiles := cloneRuntimeProfiles(cfg.RuntimeProfiles)
	if err := applyEnv(&cfg); err != nil {
		return cfg, err
	}
	applyLegacyEnv(&cfg)
	cfg.RuntimeProfiles = runtimeProfiles(cfg, tomlProfiles)

	if !validate {
		return cfg, nil
	}
	if err := validateStrictConfig(cfg); err != nil {
		return cfg, err
	}
	return cfg, nil
}
