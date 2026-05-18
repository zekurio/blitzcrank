package tools

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"blitzcrank/internal/config"
)

func TestTypeScriptSandboxRequiresReviewedPermissions(t *testing.T) {
	registry := NewRegistry(config.Config{})
	_, err := registry.Call(context.Background(), "sandbox_run_typescript", map[string]any{
		"purpose": "check status",
		"script":  "console.log('ok')",
	})
	if err == nil || !strings.Contains(err.Error(), sandboxPermissionError) {
		t.Fatalf("sandbox error = %v, want reviewed permission error", err)
	}
}

func TestTypeScriptSandboxRunsDenoWithReviewedPermissionsAndRedactsSecrets(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake deno shell script is unix-only")
	}
	dir := t.TempDir()
	argsPath := filepath.Join(dir, "args.txt")
	denoPath := filepath.Join(dir, "deno")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + shellQuote(argsPath) + "\nprintf 'secret=%s\\n' \"$SONARR_API_KEY\"\n"
	if err := os.WriteFile(denoPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	registry := NewRegistry(config.Config{
		SonarrBaseURL:   "http://sonarr.local:8989",
		SonarrAPIKey:    "sonarr-secret",
		SandboxDenoPath: denoPath,
		SandboxTimeout:  5 * time.Second,
	})
	raw, err := registry.Call(context.Background(), "sandbox_run_typescript", map[string]any{
		"purpose": "check Sonarr status",
		"script":  "console.log(Deno.env.get('SONARR_API_KEY'))",
		"_sandbox_permissions": SandboxPermissions{
			AllowNet: []string{"sonarr.local:8989"},
			AllowEnv: []string{"SONARR_API_KEY"},
		},
	})
	if err != nil {
		t.Fatalf("sandbox_run_typescript error = %v", err)
	}
	result := raw.(sandboxResult)
	if strings.Contains(result.Stdout, "sonarr-secret") || !strings.Contains(result.Stdout, "[REDACTED]") {
		t.Fatalf("stdout was not redacted: %q", result.Stdout)
	}
	argsData, err := os.ReadFile(argsPath)
	if err != nil {
		t.Fatal(err)
	}
	args := string(argsData)
	for _, want := range []string{"run", "--no-prompt", "--quiet", "--allow-net=sonarr.local:8989", "--allow-env=SONARR_API_KEY"} {
		if !strings.Contains(args, want) {
			t.Fatalf("deno args missing %q:\n%s", want, args)
		}
	}
}

func TestTypeScriptSandboxRedactsEncodedSecretVariants(t *testing.T) {
	registry := NewRegistry(config.Config{SonarrAPIKey: "sonarr-secret-value"})
	secret := "sonarr-secret-value"
	output := strings.Join([]string{
		secret,
		base64.StdEncoding.EncodeToString([]byte(secret)),
		base64.RawURLEncoding.EncodeToString([]byte(secret)),
		hex.EncodeToString([]byte(secret)),
		secret[:8],
		secret[len(secret)-8:],
	}, "\n")
	redacted := registry.redactSandboxOutput(output)
	if strings.Contains(redacted, secret) ||
		strings.Contains(redacted, base64.StdEncoding.EncodeToString([]byte(secret))) ||
		strings.Contains(redacted, hex.EncodeToString([]byte(secret))) ||
		strings.Contains(redacted, secret[:8]) ||
		strings.Contains(redacted, secret[len(secret)-8:]) {
		t.Fatalf("redacted output still contains secret material: %q", redacted)
	}
	if strings.Count(redacted, "[REDACTED]") < 6 {
		t.Fatalf("redacted output = %q, want all variants redacted", redacted)
	}
}

func TestTypeScriptSandboxReportsTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake deno shell script is unix-only")
	}
	dir := t.TempDir()
	denoPath := filepath.Join(dir, "deno")
	if err := os.WriteFile(denoPath, []byte("#!/bin/sh\nsleep 2\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	registry := NewRegistry(config.Config{SandboxDenoPath: denoPath, SandboxTimeout: time.Second})
	_, err := registry.Call(context.Background(), "sandbox_run_typescript", map[string]any{
		"purpose":              "check timeout",
		"script":               "console.log('too slow')",
		"_sandbox_permissions": SandboxPermissions{},
	})
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("sandbox error = %v, want timeout", err)
	}
}

func TestSandboxServicePermissionsExposeOnlyConfiguredValues(t *testing.T) {
	root := t.TempDir()
	registry := NewRegistry(config.Config{
		SeerrBaseURL:    "https://seerr.example",
		SeerrAPIKey:     "seerr-secret",
		SonarrBaseURL:   "http://sonarr.local:8989",
		SonarrAPIKey:    "sonarr-secret",
		FSAllowedRoots:  []string{root},
		SabnzbdBaseURL:  "",
		SabnzbdAPIKey:   "",
		JellyfinBaseURL: "",
	})
	permissions := registry.SandboxServicePermissions()
	for _, want := range []string{"seerr.example", "sonarr.local:8989"} {
		if !stringSliceContains(permissions.AllowNet, want) {
			t.Fatalf("AllowNet = %#v, missing %q", permissions.AllowNet, want)
		}
	}
	for _, want := range []string{
		"SEERR_BASE_URL",
		"SEERR_URL",
		"SEERR_API_KEY",
		"SONARR_BASE_URL",
		"SONARR_URL",
		"SONARR_API_KEY",
	} {
		if !stringSliceContains(permissions.AllowEnv, want) {
			t.Fatalf("AllowEnv = %#v, missing %q", permissions.AllowEnv, want)
		}
	}
	if stringSliceContains(permissions.AllowEnv, "SABNZBD_API_KEY") {
		t.Fatalf("AllowEnv included unconfigured SAB key: %#v", permissions.AllowEnv)
	}
	if len(permissions.AllowRead) != 1 || permissions.AllowRead[0] != root {
		t.Fatalf("AllowRead = %#v, want only %q", permissions.AllowRead, root)
	}
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func stringSliceContains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
