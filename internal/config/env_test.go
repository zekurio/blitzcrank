package config

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestParseDurationValue(t *testing.T) {
	tests := []struct {
		name    string
		raw     any
		want    time.Duration
		wantErr bool
	}{
		{name: "minutes string", raw: "5m", want: 5 * time.Minute},
		{name: "seconds string", raw: "90s", want: 90 * time.Second},
		{name: "duration passthrough", raw: 3 * time.Second, want: 3 * time.Second},
		{name: "zero string is rejected", raw: "0s", wantErr: true},
		{name: "negative string is rejected", raw: "-5m", wantErr: true},
		{name: "unparseable string", raw: "nonsense", wantErr: true},
		{name: "non-string type", raw: 5, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseDurationValue(tt.raw)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("parseDurationValue(%v) error = nil, want error", tt.raw)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseDurationValue(%v) unexpected error: %v", tt.raw, err)
			}
			if got != tt.want {
				t.Fatalf("parseDurationValue(%v) = %v, want %v", tt.raw, got, tt.want)
			}
		})
	}
}

func TestParseBoolValue(t *testing.T) {
	tests := []struct {
		name    string
		raw     any
		want    bool
		wantErr bool
	}{
		{name: "1", raw: "1", want: true},
		{name: "true", raw: "true", want: true},
		{name: "yes", raw: "yes", want: true},
		{name: "on", raw: "on", want: true},
		{name: "0", raw: "0", want: false},
		{name: "false", raw: "false", want: false},
		{name: "no", raw: "no", want: false},
		{name: "off", raw: "off", want: false},
		{name: "case insensitive", raw: "TRUE", want: true},
		{name: "invalid", raw: "maybe", wantErr: true},
		{name: "native bool passthrough", raw: true, want: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseBoolValue(tt.raw)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("parseBoolValue(%v) error = nil, want error", tt.raw)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseBoolValue(%v) unexpected error: %v", tt.raw, err)
			}
			if got != tt.want {
				t.Fatalf("parseBoolValue(%v) = %v, want %v", tt.raw, got, tt.want)
			}
		})
	}
}

func TestParseStringSlice(t *testing.T) {
	tests := []struct {
		name    string
		raw     any
		want    []string
		wantErr bool
	}{
		{name: "comma separated with spaces", raw: "a, b ,c", want: []string{"a", "b", "c"}},
		{name: "empty string", raw: "", want: nil},
		{name: "any slice with mixed types", raw: []any{"x", 1}, want: []string{"x", "1"}},
		{name: "all empty entries", raw: ", ,", want: nil},
		{name: "unsupported type", raw: 42, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseStringSlice(tt.raw)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("parseStringSlice(%v) error = nil, want error", tt.raw)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseStringSlice(%v) unexpected error: %v", tt.raw, err)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("parseStringSlice(%v) = %#v, want %#v", tt.raw, got, tt.want)
			}
		})
	}
}

func TestParseStringMap(t *testing.T) {
	tests := []struct {
		name    string
		raw     any
		want    map[string]string
		wantErr bool
	}{
		{
			name: "table with empty value dropped",
			raw:  map[string]any{"default": "m1", "seerr": ""},
			want: map[string]string{"default": "m1"},
		},
		{
			name: "json object string",
			raw:  `{"default":"m1"}`,
			want: map[string]string{"default": "m1"},
		},
		{
			name:    "invalid json string",
			raw:     "not json",
			wantErr: true,
		},
		{
			name: "empty string",
			raw:  "",
			want: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseStringMap(tt.raw)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("parseStringMap(%v) error = nil, want error", tt.raw)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseStringMap(%v) unexpected error: %v", tt.raw, err)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("parseStringMap(%v) = %#v, want %#v", tt.raw, got, tt.want)
			}
		})
	}
}

func TestFlattenTOML(t *testing.T) {
	input := map[string]any{
		"pi": map[string]any{
			"models": map[string]any{
				"default": "m",
			},
			"command": "pi",
		},
	}

	flat := flattenTOML(input, nil, map[string]any{})

	if got := flat["pi.command"]; got != "pi" {
		t.Fatalf("flat[pi.command] = %v, want %q", got, "pi")
	}

	models, ok := flat["pi.models"].(map[string]any)
	if !ok {
		t.Fatalf("flat[pi.models] = %#v, want a map[string]any", flat["pi.models"])
	}
	if models["default"] != "m" {
		t.Fatalf("flat[pi.models][default] = %v, want %q", models["default"], "m")
	}

	if got := flat["pi.models.default"]; got != "m" {
		t.Fatalf("flat[pi.models.default] = %v, want %q", got, "m")
	}
}

// TestLoadDotenv pins that loadDotenv skips blank/comment/`=`-less lines, strips one layer of
// surrounding quotes, and only ever sets a variable that is not already present in the process
// environment (existing env wins over the dotenv file).
func TestLoadDotenv(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	contents := "# a comment\n\nFOO=bar\nQUOTED=\"qq\"\nPRESET=fromfile\n"
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatalf("write dotenv: %v", err)
	}

	t.Setenv("FOO", "")
	t.Setenv("QUOTED", "")
	t.Setenv("PRESET", "fromenv")

	if err := loadDotenv(path); err != nil {
		t.Fatalf("loadDotenv() error = %v", err)
	}

	if got := os.Getenv("FOO"); got != "bar" {
		t.Fatalf("FOO = %q, want %q", got, "bar")
	}
	if got := os.Getenv("QUOTED"); got != "qq" {
		t.Fatalf("QUOTED = %q, want %q", got, "qq")
	}
	if got := os.Getenv("PRESET"); got != "fromenv" {
		t.Fatalf("PRESET = %q, want %q (existing env must win over dotenv)", got, "fromenv")
	}
}
