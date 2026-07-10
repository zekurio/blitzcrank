package jellyfin

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	maxJellyfinResponseBytes = 4 << 20
	jellyfinLogoutTimeout    = 5 * time.Second
)

var (
	ErrInvalidCredentials = errors.New("invalid Jellyfin credentials")
	ErrInsecureTransport  = errors.New("jellyfin credentials require HTTPS or a loopback URL")
)

type Client struct {
	baseURL  *url.URL
	apiKey   string
	deviceID string
	http     *http.Client
}

type AuthenticatedUser struct {
	ID string
}

type WatchedItem struct {
	Type        string
	Genres      []string
	ProviderIDs map[string]string
}

func NewClient(baseURL, apiKey string, httpClient *http.Client) (*Client, error) {
	baseURL = strings.TrimSpace(baseURL)
	if baseURL == "" {
		return nil, errors.New("jellyfin base URL is required")
	}
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return nil, fmt.Errorf("parse Jellyfin base URL: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, errors.New("jellyfin base URL must use http or https")
	}
	if parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("jellyfin base URL must contain only scheme, host, and path")
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 15 * time.Second}
	}
	digest := sha256.Sum256([]byte(parsed.String()))
	client := &Client{
		baseURL:  parsed,
		apiKey:   strings.TrimSpace(apiKey),
		deviceID: "blitzcrank-" + hex.EncodeToString(digest[:8]),
		http:     httpClient,
	}
	if client.apiKey != "" && !client.allowsPasswordAuthentication() {
		return nil, ErrInsecureTransport
	}
	return client, nil
}

// AuthenticateUserByName proves ownership of a Jellyfin account. The
// temporary access token returned by Jellyfin is used only to log the linking
// session out and is never returned to callers or persisted.
func (c *Client) AuthenticateUserByName(ctx context.Context, username, password string) (AuthenticatedUser, error) {
	if c == nil {
		return AuthenticatedUser{}, errors.New("jellyfin client is unavailable")
	}
	username = strings.TrimSpace(username)
	if username == "" {
		return AuthenticatedUser{}, errors.New("jellyfin username is required")
	}
	body, err := json.Marshal(struct {
		Username string `json:"Username"`
		Password string `json:"Pw"`
	}{Username: username, Password: password})
	if err != nil {
		return AuthenticatedUser{}, fmt.Errorf("encode Jellyfin authentication request: %w", err)
	}
	req, err := c.request(ctx, http.MethodPost, "/Users/AuthenticateByName", nil, bytes.NewReader(body))
	if err != nil {
		return AuthenticatedUser{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	c.setClientAuthorization(req, "")
	resp, err := c.http.Do(req)
	if err != nil {
		return AuthenticatedUser{}, fmt.Errorf("authenticate Jellyfin user: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxJellyfinResponseBytes))
		return AuthenticatedUser{}, ErrInvalidCredentials
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxJellyfinResponseBytes))
		return AuthenticatedUser{}, fmt.Errorf("authenticate Jellyfin user: unexpected status %d", resp.StatusCode)
	}
	var result struct {
		AccessToken string `json:"AccessToken"`
		User        struct {
			ID string `json:"Id"`
		} `json:"User"`
	}
	decoder := json.NewDecoder(io.LimitReader(resp.Body, maxJellyfinResponseBytes))
	if err := decoder.Decode(&result); err != nil {
		return AuthenticatedUser{}, fmt.Errorf("decode Jellyfin authentication response: %w", err)
	}
	userID := strings.TrimSpace(result.User.ID)
	token := strings.TrimSpace(result.AccessToken)
	if userID == "" || token == "" {
		return AuthenticatedUser{}, errors.New("jellyfin authentication response is incomplete")
	}
	logoutCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), jellyfinLogoutTimeout)
	defer cancel()
	if err := c.logout(logoutCtx, token); err != nil {
		return AuthenticatedUser{}, err
	}
	return AuthenticatedUser{ID: userID}, nil
}

func (c *Client) WatchedItems(ctx context.Context, userID string, limit int) ([]WatchedItem, error) {
	if c == nil || strings.TrimSpace(c.apiKey) == "" {
		return nil, errors.New("jellyfin service credential is unavailable")
	}
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return nil, errors.New("jellyfin user ID is required")
	}
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	query := url.Values{
		"UserId":                 {userID},
		"Recursive":              {"true"},
		"IncludeItemTypes":       {"Movie,Series"},
		"IsPlayed":               {"true"},
		"Fields":                 {"Genres,ProviderIds"},
		"SortBy":                 {"DatePlayed"},
		"SortOrder":              {"Descending"},
		"EnableUserData":         {"true"},
		"EnableImages":           {"false"},
		"EnableTotalRecordCount": {"false"},
		"Limit":                  {strconv.Itoa(limit)},
	}
	req, err := c.request(ctx, http.MethodGet, "/Items", query, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Emby-Token", c.apiKey)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("load Jellyfin watch profile: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxJellyfinResponseBytes))
		return nil, fmt.Errorf("load Jellyfin watch profile: unexpected status %d", resp.StatusCode)
	}
	var result struct {
		Items []struct {
			Type        string            `json:"Type"`
			Genres      []string          `json:"Genres"`
			ProviderIDs map[string]string `json:"ProviderIds"`
		} `json:"Items"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxJellyfinResponseBytes)).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode Jellyfin watch profile: %w", err)
	}
	items := make([]WatchedItem, 0, len(result.Items))
	for _, item := range result.Items {
		items = append(items, WatchedItem{
			Type:        strings.TrimSpace(item.Type),
			Genres:      append([]string(nil), item.Genres...),
			ProviderIDs: cloneStrings(item.ProviderIDs),
		})
	}
	return items, nil
}

func (c *Client) logout(ctx context.Context, token string) error {
	req, err := c.request(ctx, http.MethodPost, "/Sessions/Logout", nil, nil)
	if err != nil {
		return err
	}
	c.setClientAuthorization(req, token)
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("close temporary Jellyfin linking session: %w", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxJellyfinResponseBytes))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("close temporary Jellyfin linking session: unexpected status %d", resp.StatusCode)
	}
	return nil
}

func (c *Client) request(ctx context.Context, method, endpoint string, query url.Values, body io.Reader) (*http.Request, error) {
	u := *c.baseURL
	u.Path = strings.TrimRight(u.Path, "/") + endpoint
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return nil, fmt.Errorf("create Jellyfin request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	return req, nil
}

func (c *Client) setClientAuthorization(req *http.Request, token string) {
	header := fmt.Sprintf(`MediaBrowser Client="Blitzcrank", Device="Discord", DeviceId="%s", Version="0.1.0"`, c.deviceID)
	if token = strings.TrimSpace(token); token != "" {
		header += fmt.Sprintf(`, Token="%s"`, strings.ReplaceAll(token, `"`, ""))
	}
	req.Header.Set("Authorization", header)
}

func (c *Client) allowsPasswordAuthentication() bool {
	if c == nil || c.baseURL == nil {
		return false
	}
	if strings.EqualFold(c.baseURL.Scheme, "https") {
		return true
	}
	host := strings.ToLower(strings.TrimSpace(c.baseURL.Hostname()))
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func cloneStrings(values map[string]string) map[string]string {
	if len(values) == 0 {
		return nil
	}
	cloned := make(map[string]string, len(values))
	for key, value := range values {
		cloned[key] = value
	}
	return cloned
}
