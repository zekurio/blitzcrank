package config

import (
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"blitzcrank/internal/llm/models"
)

type RuntimeProfile struct {
	Provider        string `toml:"provider,omitempty"`
	Model           string `toml:"model,omitempty"`
	ReasoningEffort string `toml:"reasoning_effort,omitempty"`
	ContextLimit    int    `toml:"context_limit,omitempty"`
	InputLimit      int    `toml:"input_limit,omitempty"`
	OutputLimit     int    `toml:"output_limit,omitempty"`
}

type ContextBudget struct {
	AutoCompact          bool
	ContextLimit         int
	InputLimit           int
	OutputLimit          int
	ReservedTokens       int
	UsableTokens         int
	TailTurns            int
	PreserveRecentTokens int
}

var runtimeProfileNames = []string{"default", "seerr", "discord", "automation", "discord_triage", "sandbox_review"}

func (cfg Config) RuntimeProfile(name string) RuntimeProfile {
	name = strings.TrimSpace(name)
	defaultProfile := RuntimeProfile{
		Provider:        cfg.Provider,
		Model:           cfg.Model,
		ReasoningEffort: cfg.ReasoningEffort,
	}
	if profile, ok := cfg.RuntimeProfiles["default"]; ok {
		defaultProfile = mergeRuntimeProfile(defaultProfile, profile)
	}
	if name == "" || name == "default" {
		return defaultProfile
	}
	base := defaultProfile
	if name == "discord_triage" {
		base.Model = "gpt-5.4-mini"
		base.ReasoningEffort = "none"
	}
	if name == "sandbox_review" {
		base.Model = "gpt-5.4-mini"
		base.ReasoningEffort = "none"
	}
	if profile, ok := cfg.RuntimeProfiles[name]; ok {
		return mergeRuntimeProfile(base, profile)
	}
	return base
}

func (cfg Config) WithRuntimeProfile(profile RuntimeProfile) Config {
	out := cfg
	if strings.TrimSpace(profile.Provider) != "" {
		out.Provider = profile.Provider
	}
	if strings.TrimSpace(profile.Model) != "" {
		out.Model = profile.Model
	}
	out.ReasoningEffort = profile.ReasoningEffort
	if profile.ContextLimit > 0 || profile.InputLimit > 0 || profile.OutputLimit > 0 {
		out.RuntimeProfiles = map[string]RuntimeProfile{"default": profile}
	}
	return out
}

func runtimeProfiles(cfg Config, fileProfiles map[string]RuntimeProfile) map[string]RuntimeProfile {
	profiles := map[string]RuntimeProfile{
		"default": {
			Provider:        cfg.Provider,
			Model:           cfg.Model,
			ReasoningEffort: cfg.ReasoningEffort,
		},
	}
	if profile, ok := fileProfiles["default"]; ok && !isEmptyRuntimeProfile(profile) {
		profiles["default"] = mergeRuntimeProfile(profiles["default"], profile)
	}
	profile := runtimeProfileFromEnv("DEFAULT", RuntimeProfile{})
	if !isEmptyRuntimeProfile(profile) {
		profiles["default"] = mergeRuntimeProfile(profiles["default"], profile)
	}
	for _, name := range []string{"seerr", "discord", "automation", "discord_triage", "sandbox_review"} {
		if profile, ok := fileProfiles[name]; ok && !isEmptyRuntimeProfile(profile) {
			profiles[name] = profile
		}
		profile := runtimeProfileFromEnv(strings.ToUpper(name), RuntimeProfile{})
		if !isEmptyRuntimeProfile(profile) {
			profiles[name] = mergeRuntimeProfile(profiles[name], profile)
		}
	}
	return profiles
}

func runtimeProfileFromEnv(prefix string, fallback RuntimeProfile) RuntimeProfile {
	profile := fallback
	envPrefix := "AGENT_" + prefix + "_"
	profile.Provider = getenv(envPrefix+"PROVIDER", profile.Provider)
	profile.Model = getenv(envPrefix+"MODEL", profile.Model)
	profile.ReasoningEffort = getenv(envPrefix+"REASONING_EFFORT", profile.ReasoningEffort)
	profile.ContextLimit = intEnv(envPrefix+"CONTEXT_LIMIT", profile.ContextLimit)
	profile.InputLimit = intEnv(envPrefix+"INPUT_LIMIT", profile.InputLimit)
	profile.OutputLimit = intEnv(envPrefix+"OUTPUT_LIMIT", profile.OutputLimit)
	return profile
}

func applyRuntimeProfilesFromTOML(cfg *Config, values map[string]any) error {
	if cfg.RuntimeProfiles == nil {
		cfg.RuntimeProfiles = map[string]RuntimeProfile{}
	}
	for _, name := range runtimeProfileNames {
		profile := cfg.RuntimeProfiles[name]
		if value, ok := values["runtime.profiles."+name+".provider"]; ok {
			profile.Provider = strings.TrimSpace(fmt.Sprint(value))
		}
		if value, ok := values["runtime.profiles."+name+".model"]; ok {
			profile.Model = strings.TrimSpace(fmt.Sprint(value))
		}
		if value, ok := values["runtime.profiles."+name+".reasoning_effort"]; ok {
			profile.ReasoningEffort = strings.TrimSpace(fmt.Sprint(value))
		}
		if value, ok := values["runtime.profiles."+name+".context_limit"]; ok {
			profile.ContextLimit = positiveIntFromConfigValue(value)
		}
		if value, ok := values["runtime.profiles."+name+".input_limit"]; ok {
			profile.InputLimit = positiveIntFromConfigValue(value)
		}
		if value, ok := values["runtime.profiles."+name+".output_limit"]; ok {
			profile.OutputLimit = positiveIntFromConfigValue(value)
		}
		if !isEmptyRuntimeProfile(profile) {
			cfg.RuntimeProfiles[name] = profile
		}
	}
	if profile, ok := cfg.RuntimeProfiles["default"]; ok {
		cfg.Provider = mergeString(cfg.Provider, profile.Provider)
		cfg.Model = mergeString(cfg.Model, profile.Model)
		cfg.ReasoningEffort = mergeString(cfg.ReasoningEffort, profile.ReasoningEffort)
	}
	return nil
}

func mergeRuntimeProfile(base, override RuntimeProfile) RuntimeProfile {
	if strings.TrimSpace(override.Provider) != "" {
		base.Provider = override.Provider
	}
	if strings.TrimSpace(override.Model) != "" {
		base.Model = override.Model
	}
	if strings.TrimSpace(override.ReasoningEffort) != "" {
		base.ReasoningEffort = override.ReasoningEffort
	}
	if override.ContextLimit > 0 {
		base.ContextLimit = override.ContextLimit
	}
	if override.InputLimit > 0 {
		base.InputLimit = override.InputLimit
	}
	if override.OutputLimit > 0 {
		base.OutputLimit = override.OutputLimit
	}
	return base
}

func isEmptyRuntimeProfile(profile RuntimeProfile) bool {
	return strings.TrimSpace(profile.Provider) == "" &&
		strings.TrimSpace(profile.Model) == "" &&
		strings.TrimSpace(profile.ReasoningEffort) == "" &&
		profile.ContextLimit == 0 &&
		profile.InputLimit == 0 &&
		profile.OutputLimit == 0
}

func cloneRuntimeProfiles(in map[string]RuntimeProfile) map[string]RuntimeProfile {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]RuntimeProfile, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func mergeString(base, override string) string {
	if strings.TrimSpace(override) != "" {
		return override
	}
	return base
}

func intEnv(key string, fallback int) int {
	value := strings.TrimSpace(getenv(key, ""))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 1 {
		return fallback
	}
	return parsed
}

func positiveIntFromConfigValue(value any) int {
	switch typed := value.(type) {
	case int:
		if typed > 0 {
			return typed
		}
	case int64:
		if typed > 0 {
			return int(typed)
		}
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(typed))
		if err == nil && parsed > 0 {
			return parsed
		}
	}
	return 0
}

func (cfg Config) RuntimeContextBudget(name string) ContextBudget {
	profile := cfg.RuntimeProfile(name)
	contextLimit, inputLimit, outputLimit := cfg.modelContextLimits(profile.Provider, profile.Model)
	if profile.ContextLimit > 0 {
		contextLimit = profile.ContextLimit
		if profile.InputLimit == 0 {
			inputLimit = 0
		}
	}
	if profile.InputLimit > 0 {
		inputLimit = profile.InputLimit
	}
	if profile.OutputLimit > 0 {
		outputLimit = profile.OutputLimit
	}

	reserved := cfg.ContextReservedTokens
	if reserved < 0 {
		reserved = 0
	}
	usable := 0
	switch {
	case inputLimit > 0:
		usable = inputLimit - reserved
	case contextLimit > 0:
		usable = contextLimit - outputLimit
	}
	if usable < 0 {
		usable = 0
	}

	tailTurns := cfg.ContextTailTurns
	if tailTurns < 1 {
		tailTurns = 2
	}
	preserveRecent := cfg.ContextPreserveRecentTokens
	if preserveRecent < 1 && usable > 0 {
		preserveRecent = usable / 4
		if preserveRecent < 2000 {
			preserveRecent = 2000
		}
		if preserveRecent > 8000 {
			preserveRecent = 8000
		}
	}

	return ContextBudget{
		AutoCompact:          cfg.ContextAutoCompact,
		ContextLimit:         contextLimit,
		InputLimit:           inputLimit,
		OutputLimit:          outputLimit,
		ReservedTokens:       reserved,
		UsableTokens:         usable,
		TailTurns:            tailTurns,
		PreserveRecentTokens: preserveRecent,
	}
}

func modelContextLimits(model string) (contextLimit, inputLimit, outputLimit int) {
	info, ok := models.Lookup(models.Source{DisableFetch: true}, "openai", model)
	if !ok {
		return 0, 0, 0
	}
	return info.Limits.Context, info.Limits.Input, info.Limits.Output
}

func (cfg Config) modelContextLimits(provider, model string) (contextLimit, inputLimit, outputLimit int) {
	provider = cfg.effectiveModelProvider(provider)
	info, ok := models.LookupEffective(models.Source{
		Path:         cfg.ModelsDevPath,
		URL:          cfg.ModelsDevURL,
		CachePath:    cfg.modelsDevCachePath(),
		DisableFetch: cfg.ModelsDevDisableFetch,
	}, provider, model)
	if !ok {
		return 0, 0, 0
	}
	return info.Limits.Context, info.Limits.Input, info.Limits.Output
}

func (cfg Config) effectiveModelProvider(provider string) string {
	provider = strings.ToLower(strings.TrimSpace(provider))
	switch provider {
	case "openai", "openai-compatible", "":
		switch strings.ToLower(strings.TrimSpace(cfg.OpenAIAuth)) {
		case "codex-oauth", "oauth":
			return "codex-oauth"
		}
		if provider == "" {
			return "openai-compatible"
		}
		return provider
	default:
		return provider
	}
}

func (cfg Config) modelsDevCachePath() string {
	if strings.TrimSpace(cfg.ModelsDevCachePath) != "" {
		return strings.TrimSpace(cfg.ModelsDevCachePath)
	}
	if strings.TrimSpace(cfg.CacheDirectory) != "" {
		return filepath.Join(strings.TrimSpace(cfg.CacheDirectory), "models.dev.json")
	}
	return ""
}
