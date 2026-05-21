package tools

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
)

func (r *Registry) ServiceRequest(ctx context.Context, service string, args map[string]any) (any, error) {
	service = strings.ToLower(strings.TrimSpace(service))
	if err := r.validateServiceConfigured(service); err != nil {
		return nil, err
	}
	method := strings.ToUpper(strings.TrimSpace(stringArg(args, "method")))
	path := strings.TrimSpace(stringArg(args, "path"))
	if method == "" {
		method = http.MethodGet
	}
	if strings.TrimSpace(stringArg(args, "purpose")) == "" {
		return nil, fmt.Errorf("purpose is required")
	}
	if err := validateServiceRequest(service, method, path, args); err != nil {
		return nil, err
	}
	slog.Debug("service request", "service", service, "method", method, "path", path, "mutating", method != http.MethodGet)
	body := args["body"]
	if body == nil {
		body = args["json"]
	}
	switch service {
	case "seerr":
		return r.seerr(ctx, method, path, body)
	case "jellyfin":
		return r.jellyfin(ctx, method, path, body)
	case "sonarr", "radarr":
		return r.arr(ctx, service, method, path, body)
	case "sabnzbd":
		return r.sabnzbdRequest(ctx, method, path)
	default:
		return nil, fmt.Errorf("unsupported service %q", service)
	}
}

func (r *Registry) validateServiceConfigured(service string) error {
	switch service {
	case "seerr":
		return requireServiceConfig("Seerr", "SEERR_BASE_URL", r.cfg.SeerrBaseURL, "SEERR_API_KEY", r.cfg.SeerrAPIKey)
	case "jellyfin":
		return requireServiceConfig("Jellyfin", "JELLYFIN_BASE_URL", r.cfg.JellyfinBaseURL, "JELLYFIN_API_KEY", r.cfg.JellyfinAPIKey)
	case "sonarr":
		return requireServiceConfig("Sonarr", "SONARR_BASE_URL", r.cfg.SonarrBaseURL, "SONARR_API_KEY", r.cfg.SonarrAPIKey)
	case "radarr":
		return requireServiceConfig("Radarr", "RADARR_BASE_URL", r.cfg.RadarrBaseURL, "RADARR_API_KEY", r.cfg.RadarrAPIKey)
	case "sabnzbd":
		return requireServiceConfig("SABnzbd", "SABNZBD_BASE_URL", r.cfg.SabnzbdBaseURL, "SABNZBD_API_KEY", r.cfg.SabnzbdAPIKey)
	default:
		return fmt.Errorf("unsupported service %q", service)
	}
}

func requireServiceConfig(service, baseEnv, baseURL, keyEnv, apiKey string) error {
	var missing []string
	if strings.TrimSpace(baseURL) == "" {
		missing = append(missing, baseEnv)
	}
	if strings.TrimSpace(apiKey) == "" {
		missing = append(missing, keyEnv)
	}
	if len(missing) > 0 {
		return fmt.Errorf("%s is not configured; missing %s", service, strings.Join(missing, " and "))
	}
	return nil
}

func validateServiceRequest(service, method, path string, args map[string]any) error {
	if path == "" || !strings.HasPrefix(path, "/") {
		return fmt.Errorf("path must be an absolute service-relative path starting with /")
	}
	lowerPath := strings.ToLower(path)
	if strings.HasPrefix(lowerPath, "http://") || strings.HasPrefix(lowerPath, "https://") || strings.Contains(lowerPath, "//") {
		return fmt.Errorf("path must be service-relative, not a full URL")
	}
	if strings.Contains(lowerPath, "apikey") || strings.Contains(lowerPath, "api_key") || strings.Contains(lowerPath, "token") {
		return fmt.Errorf("path must not include credentials")
	}
	if service == "seerr" && (strings.Contains(lowerPath, "/comment") || strings.HasSuffix(lowerPath, "/resolved")) {
		return fmt.Errorf("Seerr comments and issue resolution are owned by Blitzcrank, not Pi tools")
	}
	switch method {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return fmt.Errorf("method must be GET, POST, PUT, PATCH, or DELETE")
	}
	if method != http.MethodGet {
		if strings.TrimSpace(stringArg(args, "safety_level")) != "narrow_mutation" {
			return fmt.Errorf("mutating service requests require safety_level=narrow_mutation")
		}
		if strings.TrimSpace(stringArg(args, "safety_reason")) == "" {
			return fmt.Errorf("mutating service requests require safety_reason")
		}
	}
	return nil
}

func (r *Registry) sabnzbdRequest(ctx context.Context, method, path string) (any, error) {
	if method != http.MethodGet {
		return nil, fmt.Errorf("SABnzbd requests currently support GET only")
	}
	u, err := url.Parse(path)
	if err != nil {
		return nil, fmt.Errorf("parse SABnzbd path: %w", err)
	}
	if u.Path != "/api" {
		return nil, fmt.Errorf("SABnzbd path must be /api with query parameters")
	}
	values := u.Query()
	if strings.TrimSpace(values.Get("mode")) == "" {
		return nil, fmt.Errorf("SABnzbd mode query parameter is required")
	}
	values.Set("output", "json")
	values.Set("apikey", r.cfg.SabnzbdAPIKey)
	u.RawQuery = values.Encode()
	return r.doJSON(ctx, jsonRequest{Method: http.MethodGet, BaseURL: r.cfg.SabnzbdBaseURL, Path: u.String(), APIKey: "configured", APIHeader: "X-Blitzcrank-Internal"})
}
