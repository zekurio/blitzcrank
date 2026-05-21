package config

import "strings"

func (cfg Config) PiModelFor(source string) string {
	models := normalizePiModels(cfg.PiModels)
	if len(models) == 0 {
		return ""
	}
	for _, key := range piModelKeysForSource(source) {
		if model := strings.TrimSpace(models[key]); model != "" {
			return model
		}
	}
	return strings.TrimSpace(models["default"])
}

func piModelKeysForSource(source string) []string {
	source = strings.ToLower(strings.TrimSpace(source))
	switch {
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
