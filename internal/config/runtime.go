package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type RuntimeProfile struct {
	Provider        string `json:"provider,omitempty"`
	Model           string `json:"model,omitempty"`
	ReasoningEffort string `json:"reasoning_effort,omitempty"`
}

type RuntimeFile struct {
	SkillsDirectory      string                    `json:"skills_dir,omitempty"`
	AutomationsDirectory string                    `json:"automations_dir,omitempty"`
	AutomationsEnabled   *bool                     `json:"automations_enabled,omitempty"`
	CronEnabled          *bool                     `json:"cron_enabled,omitempty"`
	Timezone             string                    `json:"timezone,omitempty"`
	RuntimeProfiles      map[string]RuntimeProfile `json:"runtime_profiles,omitempty"`
}

var runtimeProfileNames = []string{"default", "seerr", "discord", "automation", "discord_triage"}

var runtimeProfileFields = []string{
	"provider",
	"model",
	"reasoning_effort",
}

var runtimeGlobalFields = []string{"skills_dir", "automations_dir", "automations_enabled", "timezone"}

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

func runtimeProfiles(cfg Config) map[string]RuntimeProfile {
	defaultProfile := RuntimeProfile{
		Provider:        "openai-compatible",
		Model:           "gpt-5.5",
		ReasoningEffort: cfg.ReasoningEffort,
	}
	defaultProfile = runtimeProfileFromEnv("DEFAULT", defaultProfile)
	profiles := map[string]RuntimeProfile{"default": defaultProfile}
	for _, name := range []string{"seerr", "discord", "automation", "discord_triage"} {
		profile := runtimeProfileFromEnv(strings.ToUpper(name), RuntimeProfile{})
		if !isEmptyRuntimeProfile(profile) {
			profiles[name] = profile
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

func ApplyRuntimeConfigFile(cfg *Config) error {
	for _, path := range []string{cfg.RuntimeDefaultConfigPath, cfg.RuntimeConfigPath} {
		path = strings.TrimSpace(path)
		if path == "" {
			continue
		}
		file, err := LoadRuntimeFile(path)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return err
		}
		ApplyRuntimeFile(cfg, file)
	}
	return nil
}

func ApplyRuntimeDefaultConfigFile(cfg *Config) error {
	path := strings.TrimSpace(cfg.RuntimeDefaultConfigPath)
	if path == "" {
		return nil
	}
	file, err := LoadRuntimeFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	ApplyRuntimeFile(cfg, file)
	return nil
}

func RuntimeFileFromConfig(cfg Config) RuntimeFile {
	automationsEnabled := cfg.AutomationsEnabled
	file := RuntimeFile{
		SkillsDirectory:      cfg.SkillsDirectory,
		AutomationsDirectory: cfg.AutomationsDirectory,
		AutomationsEnabled:   &automationsEnabled,
		Timezone:             cfg.Timezone,
		RuntimeProfiles:      map[string]RuntimeProfile{},
	}
	for _, name := range runtimeProfileNames {
		profile, ok := cfg.RuntimeProfiles[name]
		if !ok {
			if name == "default" {
				profile = cfg.RuntimeProfile(name)
			} else {
				continue
			}
		}
		if name == "default" || !isEmptyRuntimeProfile(profile) {
			file.RuntimeProfiles[name] = profile
		}
	}
	return file
}

func SeedRuntimeConfigFile(path string, file RuntimeFile) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return errors.New("runtime config path is required")
	}
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return SaveRuntimeFile(path, file)
}

func ApplyRuntimeFile(cfg *Config, file RuntimeFile) {
	if strings.TrimSpace(file.SkillsDirectory) != "" {
		cfg.SkillsDirectory = file.SkillsDirectory
	}
	if strings.TrimSpace(file.AutomationsDirectory) != "" {
		cfg.AutomationsDirectory = file.AutomationsDirectory
	}
	if file.AutomationsEnabled != nil {
		cfg.AutomationsEnabled = *file.AutomationsEnabled
	} else if file.CronEnabled != nil {
		cfg.AutomationsEnabled = *file.CronEnabled
	}
	if strings.TrimSpace(file.Timezone) != "" {
		cfg.Timezone = file.Timezone
	}
	if cfg.RuntimeProfiles == nil {
		cfg.RuntimeProfiles = runtimeProfiles(*cfg)
	}
	for name, profile := range file.RuntimeProfiles {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		base := cfg.RuntimeProfiles[name]
		if name == "default" {
			base = cfg.RuntimeProfile(name)
		}
		cfg.RuntimeProfiles[name] = mergeRuntimeProfile(base, profile)
	}
}

func LoadRuntimeFile(path string) (RuntimeFile, error) {
	var file RuntimeFile
	data, err := os.ReadFile(path)
	if err != nil {
		return file, err
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return file, nil
	}
	if err := json.Unmarshal(data, &file); err != nil {
		return file, fmt.Errorf("parse runtime config %s: %w", path, err)
	}
	return file, nil
}

func SaveRuntimeFile(path string, file RuntimeFile) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("runtime config path is required")
	}
	if file.RuntimeProfiles != nil {
		for name, profile := range file.RuntimeProfiles {
			if isEmptyRuntimeProfile(profile) {
				delete(file.RuntimeProfiles, name)
			}
		}
		if len(file.RuntimeProfiles) == 0 {
			file.RuntimeProfiles = nil
		}
	}
	if file.AutomationsEnabled == nil && file.CronEnabled != nil {
		file.AutomationsEnabled = file.CronEnabled
	}
	file.CronEnabled = nil
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil && filepath.Dir(path) != "." {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

func RuntimeConfigKeys() []string {
	var keys []string
	keys = append(keys, runtimeGlobalFields...)
	for _, profile := range runtimeProfileNames {
		for _, field := range runtimeProfileFields {
			keys = append(keys, "runtime."+profile+"."+field)
		}
	}
	sort.Strings(keys)
	return keys
}

func RuntimeProfileNames() []string {
	return append([]string(nil), runtimeProfileNames...)
}

func RuntimeProfileFields() []string {
	return append([]string(nil), runtimeProfileFields...)
}

func RuntimeGlobalFields() []string {
	return append([]string(nil), runtimeGlobalFields...)
}

func GetRuntimeConfigValue(cfg Config, key string) (string, error) {
	key = strings.TrimSpace(key)
	switch key {
	case "skills_dir":
		return cfg.SkillsDirectory, nil
	case "automations_dir":
		return cfg.AutomationsDirectory, nil
	case "automations_enabled", "cron_enabled":
		return strconv.FormatBool(cfg.AutomationsEnabled), nil
	case "timezone":
		return cfg.Timezone, nil
	}
	profileName, field, ok := splitRuntimeProfileKey(key)
	if !ok {
		return "", fmt.Errorf("unknown runtime config key %q", key)
	}
	return runtimeProfileField(cfg.RuntimeProfile(profileName), field)
}

func SetRuntimeConfigValue(path, key, value string) error {
	key = strings.TrimSpace(key)
	value = strings.TrimSpace(value)
	file, err := LoadRuntimeFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	switch key {
	case "skills_dir":
		file.SkillsDirectory = value
	case "automations_dir":
		file.AutomationsDirectory = value
	case "automations_enabled", "cron_enabled":
		parsed, err := strconv.ParseBool(value)
		if err != nil {
			return fmt.Errorf("%s must be true or false", key)
		}
		file.AutomationsEnabled = &parsed
		file.CronEnabled = nil
	case "timezone":
		file.Timezone = value
	default:
		profileName, field, ok := splitRuntimeProfileKey(key)
		if !ok {
			return fmt.Errorf("unknown runtime config key %q", key)
		}
		if file.RuntimeProfiles == nil {
			file.RuntimeProfiles = map[string]RuntimeProfile{}
		}
		profile := file.RuntimeProfiles[profileName]
		if err := setRuntimeProfileField(&profile, field, value); err != nil {
			return err
		}
		file.RuntimeProfiles[profileName] = profile
	}
	return SaveRuntimeFile(path, file)
}

func splitRuntimeProfileKey(key string) (string, string, bool) {
	parts := strings.Split(key, ".")
	if len(parts) != 3 || parts[0] != "runtime" || !contains(runtimeProfileNames, parts[1]) || !contains(runtimeProfileFields, parts[2]) {
		return "", "", false
	}
	return parts[1], parts[2], true
}

func runtimeProfileField(profile RuntimeProfile, field string) (string, error) {
	switch field {
	case "provider":
		return profile.Provider, nil
	case "model":
		return profile.Model, nil
	case "reasoning_effort":
		return profile.ReasoningEffort, nil
	default:
		return "", fmt.Errorf("unknown runtime profile field %q", field)
	}
}

func setRuntimeProfileField(profile *RuntimeProfile, field, value string) error {
	switch field {
	case "provider":
		profile.Provider = value
	case "model":
		profile.Model = value
	case "reasoning_effort":
		profile.ReasoningEffort = value
	default:
		return fmt.Errorf("unknown runtime profile field %q", field)
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

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
