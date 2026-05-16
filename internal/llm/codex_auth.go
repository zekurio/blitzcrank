package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"blitzcrank/internal/config"
)

const (
	codexClientID         = "app_EMoamEEZ73f0CkXaXp7hrann"
	codexIssuer           = "https://auth.openai.com"
	codexDeviceURL        = codexIssuer + "/codex/device"
	codexUserCodeURL      = codexIssuer + "/api/accounts/deviceauth/usercode"
	codexDeviceTokenURL   = codexIssuer + "/api/accounts/deviceauth/token"
	codexOAuthTokenURL    = codexIssuer + "/oauth/token"
	codexDeviceRedirect   = codexIssuer + "/deviceauth/callback"
	codexRefreshSkew      = 2 * time.Minute
	codexDefaultExpiresIn = time.Hour
)

type AuthStore struct {
	Version  int                        `json:"version"`
	Profiles map[string]CodexCredential `json:"profiles"`
}

type CodexCredential struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	IDToken      string    `json:"id_token,omitempty"`
	AccountID    string    `json:"account_id,omitempty"`
	ExpiresAt    time.Time `json:"expires_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type DeviceLogin struct {
	VerificationURL string
	UserCode        string
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token"`
	ExpiresIn    int    `json:"expires_in"`
}

type deviceCodeResponse struct {
	DeviceAuthID string `json:"device_auth_id"`
	UserCode     string `json:"user_code"`
	Interval     string `json:"interval"`
}

type deviceTokenResponse struct {
	AuthorizationCode string `json:"authorization_code"`
	CodeVerifier      string `json:"code_verifier"`
}

func CodexAuthPath(cfg config.Config) string {
	if cfg.CodexAuthStore != "" {
		return cfg.CodexAuthStore
	}
	if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
		return filepath.Join(xdg, "blitzcrank", "auth.json")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".blitzcrank-auth.json"
	}
	return filepath.Join(home, ".config", "blitzcrank", "auth.json")
}

func CodexLogin(ctx context.Context, cfg config.Config, out io.Writer) error {
	httpClient := &http.Client{Timeout: 30 * time.Second}
	reqBody := strings.NewReader(`{"client_id":"` + codexClientID + `"}`)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, codexUserCodeURL, reqBody)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "blitzcrank")

	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return fmt.Errorf("start codex device auth: %s: %s", resp.Status, strings.TrimSpace(string(data)))
	}

	var device deviceCodeResponse
	if err := json.NewDecoder(resp.Body).Decode(&device); err != nil {
		return err
	}
	interval := 5 * time.Second
	if parsed, err := time.ParseDuration(device.Interval + "s"); err == nil && parsed > 0 {
		interval = parsed
	}

	fmt.Fprintf(out, "Open %s and enter code: %s\n", codexDeviceURL, device.UserCode)
	fmt.Fprintln(out, "Waiting for Codex authorization...")

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(interval):
		}

		authCode, err := pollDeviceAuthorization(ctx, httpClient, device)
		if err != nil {
			return err
		}
		if authCode.AuthorizationCode == "" {
			continue
		}

		tokens, err := exchangeCodexCode(ctx, httpClient, authCode)
		if err != nil {
			return err
		}
		cred := credentialFromTokens(tokens)
		if err := saveCodexCredential(cfg, cred); err != nil {
			return err
		}
		fmt.Fprintf(out, "Saved Codex credentials for profile %q at %s\n", cfg.CodexAuthProfile, CodexAuthPath(cfg))
		return nil
	}
}

func CodexLogout(cfg config.Config) error {
	path := CodexAuthPath(cfg)
	unlock, err := lockAuthStore(path)
	if err != nil {
		return err
	}
	defer unlock()

	store, err := loadAuthStoreUnlocked(path)
	if err != nil {
		return err
	}
	delete(store.Profiles, cfg.CodexAuthProfile)
	return saveAuthStoreUnlocked(path, store)
}

func CodexStatus(cfg config.Config, out io.Writer) error {
	path := CodexAuthPath(cfg)
	unlock, err := lockAuthStore(path)
	if err != nil {
		return err
	}
	defer unlock()

	store, err := loadAuthStoreUnlocked(path)
	if err != nil {
		return err
	}
	cred, ok := store.Profiles[cfg.CodexAuthProfile]
	if !ok {
		fmt.Fprintf(out, "No Codex credentials for profile %q at %s\n", cfg.CodexAuthProfile, CodexAuthPath(cfg))
		return nil
	}
	status := "valid"
	if time.Now().After(cred.ExpiresAt) {
		status = "expired"
	}
	fmt.Fprintf(out, "Codex profile %q: %s, expires %s, account %s\n", cfg.CodexAuthProfile, status, cred.ExpiresAt.Format(time.RFC3339), cred.AccountID)
	return nil
}

func pollDeviceAuthorization(ctx context.Context, httpClient *http.Client, device deviceCodeResponse) (deviceTokenResponse, error) {
	body, _ := json.Marshal(map[string]string{
		"device_auth_id": device.DeviceAuthID,
		"user_code":      device.UserCode,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, codexDeviceTokenURL, strings.NewReader(string(body)))
	if err != nil {
		return deviceTokenResponse{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "blitzcrank")
	resp, err := httpClient.Do(req)
	if err != nil {
		return deviceTokenResponse{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusNotFound {
		return deviceTokenResponse{}, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return deviceTokenResponse{}, fmt.Errorf("poll codex device auth: %s: %s", resp.Status, strings.TrimSpace(string(data)))
	}
	var output deviceTokenResponse
	return output, json.NewDecoder(resp.Body).Decode(&output)
}

func exchangeCodexCode(ctx context.Context, httpClient *http.Client, authCode deviceTokenResponse) (tokenResponse, error) {
	values := url.Values{
		"grant_type":    []string{"authorization_code"},
		"code":          []string{authCode.AuthorizationCode},
		"redirect_uri":  []string{codexDeviceRedirect},
		"client_id":     []string{codexClientID},
		"code_verifier": []string{authCode.CodeVerifier},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, codexOAuthTokenURL, strings.NewReader(values.Encode()))
	if err != nil {
		return tokenResponse{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := httpClient.Do(req)
	if err != nil {
		return tokenResponse{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return tokenResponse{}, fmt.Errorf("exchange codex token: %s: %s", resp.Status, strings.TrimSpace(string(data)))
	}
	var output tokenResponse
	return output, json.NewDecoder(resp.Body).Decode(&output)
}

func refreshCodexCredential(ctx context.Context, cfg config.Config, cred CodexCredential) (CodexCredential, error) {
	values := url.Values{
		"grant_type":    []string{"refresh_token"},
		"refresh_token": []string{cred.RefreshToken},
		"client_id":     []string{codexClientID},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, codexOAuthTokenURL, strings.NewReader(values.Encode()))
	if err != nil {
		return cred, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return cred, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return cred, fmt.Errorf("refresh codex token: %s: %s", resp.Status, strings.TrimSpace(string(data)))
	}
	var tokens tokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&tokens); err != nil {
		return cred, err
	}
	refreshed := credentialFromTokens(tokens)
	if refreshed.AccountID == "" {
		refreshed.AccountID = cred.AccountID
	}
	if refreshed.RefreshToken == "" {
		refreshed.RefreshToken = cred.RefreshToken
	}
	return refreshed, saveCodexCredential(cfg, refreshed)
}

func credentialFromTokens(tokens tokenResponse) CodexCredential {
	expires := codexDefaultExpiresIn
	if tokens.ExpiresIn > 0 {
		expires = time.Duration(tokens.ExpiresIn) * time.Second
	}
	return CodexCredential{
		AccessToken:  tokens.AccessToken,
		RefreshToken: tokens.RefreshToken,
		IDToken:      tokens.IDToken,
		AccountID:    extractAccountID(tokens.IDToken, tokens.AccessToken),
		ExpiresAt:    time.Now().Add(expires),
		UpdatedAt:    time.Now(),
	}
}
