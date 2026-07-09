package config

import (
	"fmt"
	"strings"
	"time"
)

type Config struct {
	DiscordToken                string        `env:"DISCORD_TOKEN" toml:"discord.token"`
	DiscordGuildID              string        `env:"DISCORD_GUILD_ID" toml:"discord.guild_id"`
	DiscordAutomationChannelID  string        `env:"DISCORD_AUTOMATION_CHANNEL_ID" toml:"discord.automation_channel_id"`
	DiscordAutomationThreadLock bool          `env:"DISCORD_AUTOMATION_THREAD_LOCK" toml:"discord.automation_thread_lock" default:"true"`
	DiscordWatchedChannelIDs    []string      `env:"DISCORD_WATCHED_CHANNEL_IDS" toml:"discord.watched_channel_ids"`
	DiscordTriageTimeout        time.Duration `env:"DISCORD_TRIAGE_TIMEOUT" toml:"discord.triage_timeout" default:"8s"`
	DiscordRunTimeout           time.Duration `env:"DISCORD_RUN_TIMEOUT" toml:"discord.run_timeout"`
	DiscordDebounce             time.Duration `env:"DISCORD_DEBOUNCE" toml:"discord.debounce" default:"750ms"`
	DiscordThreadInactivity     time.Duration `env:"DISCORD_THREAD_INACTIVITY" toml:"discord.thread_inactivity" default:"24h"`
	DiscordRetention            time.Duration `env:"DISCORD_RETENTION" toml:"discord.retention" default:"720h"`
	DiscordMutationBudget       int           `env:"DISCORD_MUTATION_BUDGET" toml:"discord.mutation_budget" default:"3"`

	HTTPListenAddr         string `env:"BLITZCRANK_HTTP_LISTEN_ADDR" toml:"web.listen_addr"`
	SeerrWebhookListenAddr string `env:"SEERR_WEBHOOK_LISTEN_ADDR" toml:"seerr.webhook_listen_addr"`
	SeerrWebhookPath       string `env:"SEERR_WEBHOOK_PATH" toml:"seerr.webhook_path" default:"/webhooks/seerr"`
	SeerrWebhookSecret     string `env:"SEERR_WEBHOOK_SECRET" toml:"seerr.webhook_secret"`
	SeerrBaseURL           string `env:"SEERR_BASE_URL" toml:"seerr.base_url"`
	SeerrAPIKey            string `env:"SEERR_API_KEY" toml:"seerr.api_key"`

	JellyfinBaseURL  string `env:"JELLYFIN_BASE_URL" toml:"jellyfin.base_url"`
	JellyfinAPIKey   string `env:"JELLYFIN_API_KEY" toml:"jellyfin.api_key"`
	SonarrBaseURL    string `env:"SONARR_BASE_URL" toml:"sonarr.base_url"`
	SonarrAPIKey     string `env:"SONARR_API_KEY" toml:"sonarr.api_key"`
	RadarrBaseURL    string `env:"RADARR_BASE_URL" toml:"radarr.base_url"`
	RadarrAPIKey     string `env:"RADARR_API_KEY" toml:"radarr.api_key"`
	SabnzbdBaseURL   string `env:"SABNZBD_BASE_URL" toml:"sabnzbd.base_url"`
	SabnzbdAPIKey    string `env:"SABNZBD_API_KEY" toml:"sabnzbd.api_key"`
	AnvilSystemdUnit string `env:"ANVIL_SYSTEMD_UNIT" toml:"anvil.systemd_unit" default:"anvil.service"`

	PiCommand     string            `env:"PI_COMMAND" toml:"pi.command" default:"pi"`
	PiCWD         string            `env:"PI_CWD" toml:"pi.cwd" default:"."`
	PiAgentDir    string            `env:"PI_CODING_AGENT_DIR" toml:"pi.agent_dir"`
	PiSessionsDir string            `env:"PI_SESSIONS_DIR" toml:"pi.sessions_dir" default:"pi-sessions"`
	PiModels      map[string]string `env:"PI_MODELS" toml:"pi.models"`

	ConfigPath           string        `env:"BLITZCRANK_CONFIG" default:"./blitzcrank.toml"`
	AutomationsDirectory string        `env:"AUTOMATIONS_DIR" toml:"runtime.automations_dir" default:"automations"`
	AutomationsEnabled   bool          `env:"AUTOMATIONS_ENABLED" toml:"runtime.automations_enabled"`
	AutomationsExtraDirs []string      `env:"AUTOMATIONS_EXTRA_DIRS" toml:"runtime.automations_extra_dirs"`
	RunTimeout           time.Duration `env:"AGENT_RUN_TIMEOUT" toml:"runtime.run_timeout" default:"5m"`
	MaxConcurrentRuns    int           `env:"MAX_CONCURRENT_RUNS" toml:"runtime.max_concurrent_runs" default:"4"`
	DatabasePath         string        `env:"DATABASE_PATH" toml:"storage.database_path" default:"./blitzcrank.sqlite"`
	CacheDirectory       string        `env:"CACHE_DIR" toml:"storage.cache_dir"`

	SeerrBotUserID            string `env:"SEERR_BOT_USER_ID" toml:"seerr.bot_user_id"`
	SeerrBotDisplayName       string `env:"SEERR_BOT_DISPLAY_NAME" toml:"seerr.bot_display_name" default:"Blitzcrank"`
	SeerrTransientRunComments bool   `env:"SEERR_TRANSIENT_RUN_COMMENTS" toml:"seerr.transient_run_comments" default:"true"`

	SeerrRevisitsEnabled bool `env:"SEERR_REVISITS_ENABLED" toml:"seerr.revisits_enabled"`
	SeerrRevisitMax      int  `env:"SEERR_REVISIT_MAX" toml:"seerr.revisit_max" default:"5"`
	SeerrMutationBudget  int  `env:"SEERR_MUTATION_BUDGET" toml:"seerr.mutation_budget" default:"5"`

	ReviewTimeout            time.Duration `env:"REVIEW_TIMEOUT" toml:"runtime.review_timeout" default:"15s"`
	ReviewCapacity           int           `env:"REVIEW_CAPACITY" toml:"runtime.review_capacity" default:"1"`
	ConfirmationTTL          time.Duration `env:"CONFIRMATION_TTL" toml:"review.confirmation_ttl" default:"15m"`
	AutomationMutationBudget int           `env:"AUTOMATION_MUTATION_BUDGET" toml:"runtime.automation_mutation_budget" default:"5"`

	BotPublicName string `env:"BOT_PUBLIC_NAME" toml:"bot.public_name" default:"blitzcrank"`
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
	cfg.DiscordWatchedChannelIDs = normalizeStrings(cfg.DiscordWatchedChannelIDs)

	if !validate {
		return cfg, nil
	}
	if err := validateStrictConfig(cfg); err != nil {
		return cfg, fmt.Errorf("validate config: %w", err)
	}
	return cfg, nil
}

func normalizeStrings(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
