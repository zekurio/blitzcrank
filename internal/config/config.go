package config

import (
	"fmt"
	"strings"
	"time"
)

type Config struct {
	DiscordToken                string `env:"DISCORD_TOKEN" toml:"discord.token"`
	DiscordGuildID              string `env:"DISCORD_GUILD_ID" toml:"discord.guild_id"`
	DiscordAutomationChannelID  string `env:"DISCORD_AUTOMATION_CHANNEL_ID" toml:"discord.automation_channel_id"`
	DiscordChannelID            string `env:"DISCORD_CHANNEL_ID" toml:"discord.channel_id"`
	DiscordAutomationThreadLock bool   `env:"DISCORD_AUTOMATION_THREAD_LOCK" toml:"discord.automation_thread_lock" default:"true"`

	HTTPListenAddr         string `env:"BLITZCRANK_HTTP_LISTEN_ADDR" toml:"web.listen_addr"`
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

	PiCommand     string            `env:"PI_COMMAND" toml:"pi.command" default:"pi"`
	PiCWD         string            `env:"PI_CWD" toml:"pi.cwd" default:"."`
	PiAgentDir    string            `env:"PI_CODING_AGENT_DIR" toml:"pi.agent_dir"`
	PiSessionsDir string            `env:"PI_SESSIONS_DIR" toml:"pi.sessions_dir"`
	PiToolBaseURL string            `env:"PI_TOOL_BASE_URL" toml:"pi.tool_base_url"`
	PiToolSecret  string            `env:"PI_TOOL_SECRET" toml:"pi.tool_secret"`
	PiModels      map[string]string `env:"PI_MODELS" toml:"pi.models"`

	ConfigPath           string        `env:"BLITZCRANK_CONFIG" default:"./blitzcrank.toml"`
	ThreadsDirectory     string        `env:"AGENT_THREADS_DIR" toml:"runtime.threads_dir" default:"threads"`
	AutomationsDirectory string        `env:"AUTOMATIONS_DIR" toml:"runtime.automations_dir" default:"automations"`
	AutomationsEnabled   bool          `env:"AUTOMATIONS_ENABLED" toml:"runtime.automations_enabled"`
	AutomationsExtraDirs []string      `env:"AUTOMATIONS_EXTRA_DIRS" toml:"runtime.automations_extra_dirs"`
	RunTimeout           time.Duration `env:"AGENT_RUN_TIMEOUT" toml:"runtime.run_timeout" default:"5m"`
	DatabasePath         string        `env:"DATABASE_PATH" toml:"storage.database_path" default:"./blitzcrank.sqlite"`
	CacheDirectory       string        `env:"CACHE_DIR" toml:"storage.cache_dir"`

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
		return cfg, fmt.Errorf("apply config defaults: %w", err)
	}
	_ = loadDotenv(dotenvPath)
	if err := applyBootstrapEnv(&cfg); err != nil {
		return cfg, fmt.Errorf("apply bootstrap environment config: %w", err)
	}
	if strings.TrimSpace(cfg.ConfigPath) != "" {
		if err := applyTOMLFile(&cfg, cfg.ConfigPath); err != nil {
			return cfg, fmt.Errorf("apply TOML config: %w", err)
		}
	}
	if err := applyEnv(&cfg); err != nil {
		return cfg, fmt.Errorf("apply environment config overrides: %w", err)
	}
	cfg.PiModels = normalizePiModels(cfg.PiModels)
	if strings.TrimSpace(cfg.DiscordAutomationChannelID) == "" {
		cfg.DiscordAutomationChannelID = strings.TrimSpace(cfg.DiscordChannelID)
	}

	if !validate {
		return cfg, nil
	}
	if err := validateStrictConfig(cfg); err != nil {
		return cfg, fmt.Errorf("validate config: %w", err)
	}
	return cfg, nil
}
