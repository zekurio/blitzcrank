package config

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strconv"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
)

func loadDotenv(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open dotenv %s: %w", path, err)
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
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read dotenv %s: %w", path, err)
	}
	return nil
}

func getenv(key, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
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

func codexServiceTierFromFastEnv(key, fallback string) string {
	value := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	if value == "" {
		return fallback
	}
	switch value {
	case "1", "true", "yes", "on":
		return "fast"
	case "0", "false", "no", "off":
		return "standard"
	default:
		return fallback
	}
}

func applyDefaults(cfg *Config) error {
	return walkConfigFields(cfg, func(field reflect.Value, structField reflect.StructField) error {
		value := strings.TrimSpace(structField.Tag.Get("default"))
		if value == "" {
			return nil
		}
		return setConfigField(field, value)
	})
}

func applyEnv(cfg *Config) error {
	return walkConfigFields(cfg, func(field reflect.Value, structField reflect.StructField) error {
		key := strings.TrimSpace(structField.Tag.Get("env"))
		if key == "" {
			return nil
		}
		value, ok := os.LookupEnv(key)
		if !ok || strings.TrimSpace(value) == "" {
			return nil
		}
		return setConfigField(field, value)
	})
}

func applyLegacyEnv(cfg *Config) {
	if strings.TrimSpace(os.Getenv("AUTOMATIONS_ENABLED")) == "" {
		cfg.AutomationsEnabled = boolEnv("CRON_ENABLED", cfg.AutomationsEnabled)
	}
	if strings.TrimSpace(os.Getenv("CODEX_SERVICE_TIER")) == "" {
		cfg.CodexServiceTier = codexServiceTierFromFastEnv("CODEX_FAST_MODE", cfg.CodexServiceTier)
	}
}

func applyTOMLFile(cfg *Config, path string) error {
	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("open config %s: %w", path, err)
	}
	defer file.Close()

	var tree map[string]any
	if _, err := toml.NewDecoder(file).Decode(&tree); err != nil {
		return fmt.Errorf("parse config %s: %w", path, err)
	}
	flat := flattenTOML(tree, nil, map[string]any{})
	if err := applyTOMLValues(cfg, flat); err != nil {
		return fmt.Errorf("apply config values: %w", err)
	}
	if err := applyRuntimeProfilesFromTOML(cfg, flat); err != nil {
		return fmt.Errorf("apply runtime profiles: %w", err)
	}
	return nil
}

func applyTOMLValues(cfg *Config, values map[string]any) error {
	return walkConfigFields(cfg, func(field reflect.Value, structField reflect.StructField) error {
		key := strings.TrimSpace(structField.Tag.Get("toml"))
		if key == "" {
			return nil
		}
		value, ok := values[key]
		if !ok {
			return nil
		}
		return setConfigFieldValue(field, value)
	})
}

func flattenTOML(value any, path []string, out map[string]any) map[string]any {
	switch typed := value.(type) {
	case map[string]any:
		if len(path) > 0 {
			out[strings.Join(path, ".")] = typed
		}
		for key, child := range typed {
			flattenTOML(child, append(path, key), out)
		}
	case map[any]any:
		if len(path) > 0 {
			out[strings.Join(path, ".")] = typed
		}
		for key, child := range typed {
			flattenTOML(child, append(path, fmt.Sprint(key)), out)
		}
	default:
		out[strings.Join(path, ".")] = value
	}
	return out
}

func walkConfigFields(cfg *Config, visit func(reflect.Value, reflect.StructField) error) error {
	value := reflect.ValueOf(cfg).Elem()
	typ := value.Type()
	for i := 0; i < value.NumField(); i++ {
		field := value.Field(i)
		if !field.CanSet() {
			continue
		}
		if err := visit(field, typ.Field(i)); err != nil {
			return err
		}
	}
	return nil
}

func setConfigField(field reflect.Value, raw string) error {
	return setConfigFieldValue(field, raw)
}

func setConfigFieldValue(field reflect.Value, raw any) error {
	switch field.Kind() {
	case reflect.String:
		field.SetString(strings.TrimSpace(fmt.Sprint(raw)))
	case reflect.Int, reflect.Int64:
		if field.Type() == reflect.TypeOf(time.Duration(0)) {
			parsed, err := parseDurationValue(raw)
			if err != nil {
				return err
			}
			field.SetInt(int64(parsed))
			return nil
		}
		parsed, err := parseIntValue(raw)
		if err != nil {
			return err
		}
		field.SetInt(parsed)
	case reflect.Float64:
		parsed, err := parseFloatValue(raw)
		if err != nil {
			return err
		}
		field.SetFloat(parsed)
	case reflect.Bool:
		parsed, err := parseBoolValue(raw)
		if err != nil {
			return err
		}
		field.SetBool(parsed)
	case reflect.Slice:
		values, err := parseStringSlice(raw)
		if err != nil {
			return err
		}
		field.Set(reflect.ValueOf(values))
	case reflect.Map:
		values, err := parseStringMap(raw)
		if err != nil {
			return err
		}
		field.Set(reflect.ValueOf(values))
	default:
		return fmt.Errorf("unsupported config field type %s", field.Type())
	}
	return nil
}

func parseDurationValue(raw any) (time.Duration, error) {
	switch value := raw.(type) {
	case time.Duration:
		return value, nil
	case string:
		parsed, err := time.ParseDuration(strings.TrimSpace(value))
		if err != nil {
			return 0, err
		}
		if parsed <= 0 {
			return 0, fmt.Errorf("duration must be positive")
		}
		return parsed, nil
	default:
		return 0, fmt.Errorf("duration must be a string")
	}
}

func parseIntValue(raw any) (int64, error) {
	switch value := raw.(type) {
	case int:
		return int64(value), nil
	case int64:
		return value, nil
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(value))
		return int64(parsed), err
	default:
		return 0, fmt.Errorf("integer value must be a number or string")
	}
}

func parseFloatValue(raw any) (float64, error) {
	switch value := raw.(type) {
	case float64:
		return value, nil
	case int64:
		return float64(value), nil
	case string:
		return strconv.ParseFloat(strings.TrimSpace(value), 64)
	default:
		return 0, fmt.Errorf("float value must be a number or string")
	}
}

func parseBoolValue(raw any) (bool, error) {
	switch value := raw.(type) {
	case bool:
		return value, nil
	case string:
		switch strings.ToLower(strings.TrimSpace(value)) {
		case "1", "true", "yes", "on":
			return true, nil
		case "0", "false", "no", "off":
			return false, nil
		default:
			return false, fmt.Errorf("boolean value must be true or false")
		}
	default:
		return false, fmt.Errorf("boolean value must be true or false")
	}
}

func parseStringSlice(raw any) ([]string, error) {
	switch value := raw.(type) {
	case []string:
		return cleanStringSlice(value), nil
	case []any:
		values := make([]string, 0, len(value))
		for _, item := range value {
			values = append(values, fmt.Sprint(item))
		}
		return cleanStringSlice(values), nil
	case string:
		if strings.TrimSpace(value) == "" {
			return nil, nil
		}
		return cleanStringSlice(strings.Split(value, ",")), nil
	default:
		return nil, fmt.Errorf("list value must be an array or comma-separated string")
	}
}

func cleanStringSlice(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			out = append(out, value)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func parseStringMap(raw any) (map[string]string, error) {
	switch value := raw.(type) {
	case map[string]string:
		return cleanStringMap(value), nil
	case map[string]any:
		out := map[string]string{}
		for key, item := range value {
			out[key] = fmt.Sprint(item)
		}
		return cleanStringMap(out), nil
	case map[any]any:
		out := map[string]string{}
		for key, item := range value {
			out[fmt.Sprint(key)] = fmt.Sprint(item)
		}
		return cleanStringMap(out), nil
	case string:
		if strings.TrimSpace(value) == "" {
			return nil, nil
		}
		var parsed map[string]any
		if err := json.Unmarshal([]byte(value), &parsed); err != nil {
			return nil, err
		}
		out := map[string]string{}
		for key, item := range parsed {
			out[key] = fmt.Sprint(item)
		}
		return cleanStringMap(out), nil
	default:
		return nil, fmt.Errorf("map value must be a table or JSON object string")
	}
}

func cleanStringMap(values map[string]string) map[string]string {
	out := map[string]string{}
	for key, value := range values {
		key = strings.TrimSpace(key)
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
