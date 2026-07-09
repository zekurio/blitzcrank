package config

import "strings"

func (cfg Config) PiModelFor(source string) string {
	models := normalizePiModels(cfg.PiModels)
	if len(models) == 0 {
		return ""
	}
	keys := piModelKeysForSource(source)
	for _, key := range keys {
		if model := strings.TrimSpace(models[key]); model != "" {
			return model
		}
	}
	// Mutation review is an independent safety boundary. It must never silently
	// inherit the working agent's default model when its dedicated entry is
	// absent, even for callers using relaxed configuration loading.
	if len(keys) == 1 && keys[0] == "review" {
		return ""
	}
	return strings.TrimSpace(models["default"])
}

func piModelKeysForSource(source string) []string {
	source = strings.ToLower(strings.TrimSpace(source))
	switch {
	case source == "discord_triage", source == "discord-triage", strings.HasPrefix(source, "discord_triage_"):
		return []string{"discord_triage"}
	case strings.HasPrefix(source, "discord"):
		return []string{"discord"}
	case source == "review", strings.HasPrefix(source, "review_"), strings.HasPrefix(source, "mutation_review"):
		return []string{"review"}
	case strings.HasPrefix(source, "automation"):
		return []string{"automation"}
	case strings.HasPrefix(source, "seerr"):
		return []string{"seerr"}
	default:
		return nil
	}
}

func normalizePiModels(in map[string]string) map[string]string {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]string, len(in))
	for key, value := range in {
		key = strings.ToLower(strings.TrimSpace(key))
		value = strings.TrimSpace(value)
		if key != "" && value != "" {
			out[key] = value
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
