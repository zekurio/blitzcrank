package tools

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	sandboxScriptArg       = "script"
	sandboxPurposeArg      = "purpose"
	sandboxTimeoutArg      = "timeout_seconds"
	sandboxPermissionsArg  = "_sandbox_permissions"
	sandboxOutputLimit     = 64 << 10
	defaultSandboxTimeout  = 20 * time.Second
	maxSandboxTimeout      = 60 * time.Second
	sandboxPermissionError = "sandbox permissions were not reviewed"
)

type sandboxResult struct {
	ExitCode int    `json:"exit_code"`
	Stdout   string `json:"stdout,omitempty"`
	Stderr   string `json:"stderr,omitempty"`
}

func (r *Registry) callSandboxTool(ctx context.Context, name string, args map[string]any) (any, bool, error) {
	switch name {
	case "sandbox_run_typescript":
		result, err := r.runTypeScriptSandbox(ctx, args)
		return result, true, err
	default:
		return nil, false, nil
	}
}

func (r *Registry) runTypeScriptSandbox(ctx context.Context, args map[string]any) (any, error) {
	script := strings.TrimSpace(stringArg(args, sandboxScriptArg))
	if script == "" {
		return nil, fmt.Errorf("script is required")
	}
	if strings.TrimSpace(stringArg(args, sandboxPurposeArg)) == "" {
		return nil, fmt.Errorf("purpose is required")
	}
	permissions, err := sandboxPermissionsArgValue(args)
	if err != nil {
		return nil, err
	}
	timeout, err := sandboxTimeout(args, r.cfg.SandboxTimeout)
	if err != nil {
		return nil, err
	}

	dir, err := os.MkdirTemp("", "blitzcrank-deno-*")
	if err != nil {
		return nil, fmt.Errorf("create sandbox temp dir: %w", err)
	}
	defer os.RemoveAll(dir)

	scriptPath := filepath.Join(dir, "main.ts")
	if err := os.WriteFile(scriptPath, []byte(script), 0o600); err != nil {
		return nil, fmt.Errorf("write sandbox script: %w", err)
	}

	commandCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command := exec.CommandContext(commandCtx, sandboxDenoPath(r.cfg.SandboxDenoPath), sandboxDenoArgs(scriptPath, permissions)...)
	command.Dir = dir
	command.Env = sandboxEnv(os.Environ(), r.serviceSandboxEnv(), permissions.AllowEnv)

	output, err := command.CombinedOutput()
	if commandCtx.Err() == context.DeadlineExceeded {
		return nil, fmt.Errorf("sandbox timed out after %s", timeout.Round(time.Second))
	}
	redacted := r.redactSandboxOutput(string(limitBytes(output, sandboxOutputLimit)))
	exitCode := -1
	if command.ProcessState != nil {
		exitCode = command.ProcessState.ExitCode()
	}
	result := sandboxResult{ExitCode: exitCode}
	if redacted != "" {
		if err != nil {
			result.Stderr = redacted
		} else {
			result.Stdout = redacted
		}
	}
	if err != nil {
		detail := strings.TrimSpace(redacted)
		if detail != "" {
			return result, fmt.Errorf("sandbox failed with exit code %d: %s", result.ExitCode, limitString(detail, 2000))
		}
		return result, fmt.Errorf("sandbox failed with exit code %d", result.ExitCode)
	}
	return result, nil
}

func sandboxPermissionsArgValue(args map[string]any) (SandboxPermissions, error) {
	raw, ok := args[sandboxPermissionsArg]
	if !ok {
		return SandboxPermissions{}, fmt.Errorf(sandboxPermissionError)
	}
	data, err := json.Marshal(raw)
	if err != nil {
		return SandboxPermissions{}, fmt.Errorf("encode sandbox permissions: %w", err)
	}
	var permissions SandboxPermissions
	if err := json.Unmarshal(data, &permissions); err != nil {
		return SandboxPermissions{}, fmt.Errorf("decode sandbox permissions: %w", err)
	}
	return permissions, nil
}

func sandboxTimeout(args map[string]any, configured time.Duration) (time.Duration, error) {
	timeout := configured
	if timeout <= 0 {
		timeout = defaultSandboxTimeout
	}
	seconds, err := intArg(args, sandboxTimeoutArg)
	if err != nil {
		return 0, err
	}
	if seconds > 0 {
		timeout = time.Duration(seconds) * time.Second
	}
	if timeout <= 0 || timeout > maxSandboxTimeout {
		return 0, fmt.Errorf("timeout_seconds must be between 1 and 60")
	}
	return timeout, nil
}

func sandboxDenoPath(path string) string {
	if strings.TrimSpace(path) == "" {
		return "deno"
	}
	return strings.TrimSpace(path)
}

func sandboxDenoArgs(scriptPath string, permissions SandboxPermissions) []string {
	args := []string{"run", "--no-prompt", "--quiet"}
	if len(permissions.AllowNet) > 0 {
		args = append(args, "--allow-net="+strings.Join(permissions.AllowNet, ","))
	}
	if len(permissions.AllowEnv) > 0 {
		args = append(args, "--allow-env="+strings.Join(permissions.AllowEnv, ","))
	}
	if len(permissions.AllowRead) > 0 {
		args = append(args, "--allow-read="+strings.Join(permissions.AllowRead, ","))
	}
	if len(permissions.AllowWrite) > 0 {
		args = append(args, "--allow-write="+strings.Join(permissions.AllowWrite, ","))
	}
	return append(args, scriptPath)
}

func (r *Registry) serviceSandboxEnv() map[string]string {
	values := map[string]string{
		"SEERR_BASE_URL":    r.cfg.SeerrBaseURL,
		"SEERR_API_KEY":     r.cfg.SeerrAPIKey,
		"JELLYFIN_BASE_URL": r.cfg.JellyfinBaseURL,
		"JELLYFIN_API_KEY":  r.cfg.JellyfinAPIKey,
		"SONARR_BASE_URL":   r.cfg.SonarrBaseURL,
		"SONARR_API_KEY":    r.cfg.SonarrAPIKey,
		"RADARR_BASE_URL":   r.cfg.RadarrBaseURL,
		"RADARR_API_KEY":    r.cfg.RadarrAPIKey,
		"SABNZBD_BASE_URL":  r.cfg.SabnzbdBaseURL,
		"SABNZBD_API_KEY":   r.cfg.SabnzbdAPIKey,
		"BOT_TIMEZONE":      r.cfg.Timezone,
	}
	for key, value := range values {
		if strings.TrimSpace(value) == "" {
			delete(values, key)
		}
	}
	return values
}

func sandboxEnv(base []string, service map[string]string, allowed []string) []string {
	baseAllowed := map[string]bool{
		"HOME":   true,
		"PATH":   true,
		"TMPDIR": true,
	}
	serviceAllowed := make(map[string]bool, len(allowed))
	for _, key := range allowed {
		key = strings.TrimSpace(key)
		if key != "" {
			serviceAllowed[key] = true
		}
	}
	out := make([]string, 0, len(baseAllowed)+len(serviceAllowed))
	for _, entry := range base {
		key, _, ok := strings.Cut(entry, "=")
		if ok && baseAllowed[key] {
			out = append(out, entry)
		}
	}
	for key, value := range service {
		if serviceAllowed[key] {
			out = append(out, key+"="+value)
		}
	}
	return out
}

func (r *Registry) redactSandboxOutput(value string) string {
	for _, secret := range []string{r.cfg.SeerrAPIKey, r.cfg.JellyfinAPIKey, r.cfg.SonarrAPIKey, r.cfg.RadarrAPIKey, r.cfg.SabnzbdAPIKey} {
		for _, variant := range secretRedactionVariants(secret) {
			value = strings.ReplaceAll(value, variant, "[REDACTED]")
		}
	}
	return strings.TrimSpace(value)
}

func secretRedactionVariants(secret string) []string {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return nil
	}
	values := []string{
		secret,
		url.QueryEscape(secret),
		base64.StdEncoding.EncodeToString([]byte(secret)),
		base64.RawStdEncoding.EncodeToString([]byte(secret)),
		base64.URLEncoding.EncodeToString([]byte(secret)),
		base64.RawURLEncoding.EncodeToString([]byte(secret)),
		hex.EncodeToString([]byte(secret)),
	}
	if len(secret) >= 8 {
		values = append(values, secret[:8], secret[len(secret)-8:])
	}
	return uniqueNonEmpty(values)
}

func (r *Registry) SandboxServicePermissions() SandboxPermissions {
	env := r.serviceSandboxEnv()
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	netHosts := make([]string, 0, 5)
	for _, rawURL := range []string{r.cfg.SeerrBaseURL, r.cfg.JellyfinBaseURL, r.cfg.SonarrBaseURL, r.cfg.RadarrBaseURL, r.cfg.SabnzbdBaseURL} {
		if host := sandboxNetHost(rawURL); host != "" {
			netHosts = append(netHosts, host)
		}
	}
	return SandboxPermissions{AllowNet: uniqueNonEmpty(netHosts), AllowEnv: uniqueNonEmpty(keys), AllowRead: uniqueNonEmpty(r.cfg.FSAllowedRoots)}
}

func (r *Registry) SandboxReferencedPermissions(script string) SandboxPermissions {
	env := r.serviceSandboxEnv()
	netHosts := make([]string, 0, 5)
	envKeys := make([]string, 0, len(env))
	for key, value := range env {
		if !scriptReferencesServiceEnv(script, key) {
			continue
		}
		envKeys = append(envKeys, key)
		if host := sandboxNetHost(value); host != "" {
			netHosts = append(netHosts, host)
		}
	}
	return SandboxPermissions{AllowNet: uniqueNonEmpty(netHosts), AllowEnv: uniqueNonEmpty(envKeys)}
}

func scriptReferencesServiceEnv(script, key string) bool {
	if strings.Contains(script, key) {
		return true
	}
	if !strings.Contains(script, "Deno.env.get") {
		return false
	}
	service, suffix, ok := strings.Cut(key, "_")
	if !ok || service == "" || suffix == "" {
		return false
	}
	compact := strings.ToLower(script)
	return strings.Contains(compact, strings.ToLower(service)) &&
		strings.Contains(compact, strings.ToLower(suffix))
}

func sandboxNetHost(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" {
		return ""
	}
	return parsed.Host
}

func limitBytes(data []byte, limit int) []byte {
	if len(data) <= limit {
		return data
	}
	suffix := []byte("\n[output truncated after " + strconv.Itoa(limit) + " bytes]")
	return append(data[:limit], suffix...)
}

func uniqueNonEmpty(values []string) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func limitString(value string, limit int) string {
	if limit <= 0 || len(value) <= limit {
		return value
	}
	return value[:limit] + "... [truncated]"
}
