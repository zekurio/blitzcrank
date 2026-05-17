package config

import (
	"fmt"
	"strings"
)

type RuntimeProfile struct {
	Provider        string `toml:"provider,omitempty"`
	Model           string `toml:"model,omitempty"`
	ReasoningEffort string `toml:"reasoning_effort,omitempty"`
}

var runtimeProfileNames = []string{"default", "seerr", "discord", "automation", "discord_triage"}

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
	for _, name := range []string{"seerr", "discord", "automation", "discord_triage"} {
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
	return base
}

func isEmptyRuntimeProfile(profile RuntimeProfile) bool {
	return strings.TrimSpace(profile.Provider) == "" &&
		strings.TrimSpace(profile.Model) == "" &&
		strings.TrimSpace(profile.ReasoningEffort) == ""
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
