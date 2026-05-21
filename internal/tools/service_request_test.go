package tools

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"blitzcrank/internal/config"
)

func TestJellyfinRequestUsesMediaBrowserAuthorizationHeader(t *testing.T) {
	var gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if legacy := r.Header.Get("X-Emby-Token"); legacy != "" {
			t.Fatalf("X-Emby-Token = %q, want empty", legacy)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	registry := NewRegistry(config.Config{JellyfinBaseURL: server.URL, JellyfinAPIKey: "secret token"})
	_, err := registry.ServiceRequest(context.Background(), "jellyfin", map[string]any{
		"purpose": "verify auth header",
		"method":  "GET",
		"path":    "/Items?limit=1",
	})
	if err != nil {
		t.Fatalf("ServiceRequest() error = %v", err)
	}
	want := `MediaBrowser Token="secret+token", Client="Blitzcrank", Device="Blitzcrank+Gateway", DeviceId="blitzcrank-gateway", Version="0.1.0"`
	if gotAuth != want {
		t.Fatalf("Authorization = %q, want %q", gotAuth, want)
	}
}

func TestServiceRequestReportsMissingConfigEnvNames(t *testing.T) {
	tests := []struct {
		name    string
		service string
		want    string
	}{
		{name: "seerr", service: "seerr", want: "missing SEERR_BASE_URL and SEERR_API_KEY"},
		{name: "jellyfin", service: "jellyfin", want: "missing JELLYFIN_BASE_URL and JELLYFIN_API_KEY"},
		{name: "sonarr", service: "sonarr", want: "missing SONARR_BASE_URL and SONARR_API_KEY"},
		{name: "radarr", service: "radarr", want: "missing RADARR_BASE_URL and RADARR_API_KEY"},
		{name: "sabnzbd", service: "sabnzbd", want: "missing SABNZBD_BASE_URL and SABNZBD_API_KEY"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			registry := NewRegistry(config.Config{})
			_, err := registry.ServiceRequest(context.Background(), tt.service, map[string]any{
				"purpose": "verify config",
				"path":    "/Items",
			})
			if err == nil {
				t.Fatal("ServiceRequest() error = nil, want missing config error")
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error = %q, want substring %q", err.Error(), tt.want)
			}
		})
	}
}
