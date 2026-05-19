package models

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	diskcache "blitzcrank/internal/cache"
)

const (
	DefaultURL      = "https://models.dev"
	defaultCacheTTL = 5 * time.Minute
)

type Source struct {
	Path         string
	URL          string
	CachePath    string
	DisableFetch bool
}

type Limits struct {
	Context int
	Input   int
	Output  int
}

type Info struct {
	Provider              string
	ID                    string
	Name                  string
	Family                string
	Status                string
	Limits                Limits
	Reasoning             bool
	ToolCall              bool
	Temperature           bool
	StructuredOutput      bool
	SupportsFastMode      bool
	SupportsParallelTools bool
}

type Catalog struct {
	models map[string]Info
}

type modelsDevProvider struct {
	ID     string                    `json:"id"`
	Models map[string]modelsDevModel `json:"models"`
}

type modelsDevModel struct {
	ID               string                `json:"id"`
	Name             string                `json:"name"`
	Family           string                `json:"family"`
	Status           string                `json:"status"`
	Reasoning        bool                  `json:"reasoning"`
	ToolCall         bool                  `json:"tool_call"`
	Temperature      bool                  `json:"temperature"`
	StructuredOutput bool                  `json:"structured_output"`
	Limit            modelsDevLimit        `json:"limit"`
	Experimental     modelsDevExperimental `json:"experimental"`
}

type modelsDevExperimental struct {
	Modes map[string]modelsDevMode `json:"modes"`
}

type modelsDevMode struct {
	Provider *struct {
		Body map[string]any `json:"body"`
	} `json:"provider"`
}

type modelsDevLimit struct {
	Context int `json:"context"`
	Input   int `json:"input"`
	Output  int `json:"output"`
}

func NewCatalogFromModelsDevJSON(data []byte) (*Catalog, error) {
	var providers map[string]modelsDevProvider
	if err := json.Unmarshal(data, &providers); err != nil {
		return nil, err
	}
	catalog := &Catalog{models: map[string]Info{}}
	for providerID, provider := range providers {
		providerName := strings.TrimSpace(provider.ID)
		if providerName == "" {
			providerName = providerID
		}
		for modelID, model := range provider.Models {
			id := strings.TrimSpace(model.ID)
			if id == "" {
				id = modelID
			}
			info := Info{
				Provider:              providerName,
				ID:                    id,
				Name:                  strings.TrimSpace(model.Name),
				Family:                strings.TrimSpace(model.Family),
				Status:                strings.TrimSpace(model.Status),
				Limits:                Limits{Context: model.Limit.Context, Input: model.Limit.Input, Output: model.Limit.Output},
				Reasoning:             model.Reasoning,
				ToolCall:              model.ToolCall,
				Temperature:           model.Temperature,
				StructuredOutput:      model.StructuredOutput,
				SupportsFastMode:      modelSupportsFastMode(model),
				SupportsParallelTools: model.ToolCall,
			}
			catalog.add(info)
		}
	}
	return catalog, nil
}

func LoadModelsDevFile(path string) (*Catalog, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return NewCatalogFromModelsDevJSON(data)
}

func Lookup(source Source, provider, model string) (Info, bool) {
	if catalog, ok := cachedCatalog(source); ok {
		return catalog.Lookup(provider, model)
	}
	return Info{}, false
}

func LookupEffective(source Source, provider, model string) (Info, bool) {
	info, ok := Lookup(source, provider, model)
	if !ok {
		return Info{}, false
	}
	return ApplyProviderOverrides(provider, info), true
}

func (c *Catalog) Lookup(provider, model string) (Info, bool) {
	if c == nil {
		return Info{}, false
	}
	provider = normalizeLookupProvider(provider)
	model = normalizeModel(model)
	if model == "" {
		return Info{}, false
	}
	keys := []string{model}
	if provider != "" {
		keys = append([]string{provider + "/" + model}, keys...)
	}
	if prefix, suffix, ok := strings.Cut(model, "/"); ok {
		keys = append([]string{prefix + "/" + suffix, suffix}, keys...)
	}
	for _, key := range keys {
		if info, ok := c.models[key]; ok {
			return info, true
		}
	}
	return Info{}, false
}

func (c *Catalog) add(info Info) {
	if c.models == nil {
		c.models = map[string]Info{}
	}
	provider := normalizeProviderID(info.Provider)
	model := normalizeModel(info.ID)
	if model == "" {
		return
	}
	if !strings.Contains(model, "/") {
		c.models[model] = info
	}
	if provider != "" {
		c.models[provider+"/"+model] = info
	}
}

func modelSupportsFastMode(model modelsDevModel) bool {
	for name, mode := range model.Experimental.Modes {
		if strings.EqualFold(name, "fast") && mode.Provider != nil && mode.Provider.Body != nil {
			if _, ok := mode.Provider.Body["service_tier"]; ok {
				return true
			}
		}
	}
	return false
}

func ApplyProviderOverrides(provider string, info Info) Info {
	if normalizeProviderID(provider) == "codex-oauth" && strings.Contains(normalizeModel(info.ID), "gpt-5.5") {
		info.Limits = Limits{Context: 400000, Input: 272000, Output: 128000}
	}
	return info
}

func normalizeProviderID(provider string) string {
	return strings.ToLower(strings.TrimSpace(provider))
}

func normalizeLookupProvider(provider string) string {
	provider = strings.ToLower(strings.TrimSpace(provider))
	switch provider {
	case "openai-compatible", "codex-oauth":
		return "openai"
	case "":
		return ""
	default:
		return provider
	}
}

func normalizeModel(model string) string {
	model = strings.ToLower(strings.TrimSpace(model))
	if prefix, _, ok := strings.Cut(model, ":"); ok {
		model = prefix
	}
	return model
}

var (
	cacheMu sync.Mutex
	cache   = map[string]*Catalog{}
)

func cachedCatalog(source Source) (*Catalog, bool) {
	key := sourceCacheKey(source)
	cacheMu.Lock()
	defer cacheMu.Unlock()
	if catalog, ok := cache[key]; ok {
		return catalog, catalog != nil
	}
	catalog, err := loadCatalog(source)
	if err != nil {
		cache[key] = nil
		return nil, false
	}
	cache[key] = catalog
	return catalog, true
}

func sourceCacheKey(source Source) string {
	return strings.Join([]string{
		strings.TrimSpace(source.Path),
		strings.TrimSpace(source.URL),
		strings.TrimSpace(source.CachePath),
		fmt.Sprintf("%t", source.DisableFetch),
	}, "\x00")
}

func loadCatalog(source Source) (*Catalog, error) {
	if path := strings.TrimSpace(source.Path); path != "" {
		return LoadModelsDevFile(path)
	}
	cachePath := effectiveCachePath(source.CachePath)
	if cachePath != "" {
		if catalog, ok := loadFreshCache(cachePath, defaultCacheTTL); ok {
			return catalog, nil
		}
		if !source.DisableFetch {
			if catalog, err := fetchCatalog(source); err == nil {
				return catalog, nil
			}
		}
	}
	if !source.DisableFetch && cachePath == "" {
		return fetchCatalog(source)
	}
	if cachePath != "" {
		return LoadModelsDevFile(cachePath)
	}
	return nil, os.ErrNotExist
}

func effectiveCachePath(path string) string {
	path = strings.TrimSpace(path)
	if path != "" {
		return path
	}
	return diskcache.UserPath("models.dev.json")
}

func loadFreshCache(path string, ttl time.Duration) (*Catalog, bool) {
	entry, ok := diskcache.File{Path: path, TTL: ttl}.ReadFresh(contextWithoutCancel())
	if !ok {
		return nil, false
	}
	catalog, err := NewCatalogFromModelsDevJSON(entry.Data)
	return catalog, err == nil
}

func fetchCatalog(source Source) (*Catalog, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(source.URL), "/")
	if baseURL == "" {
		baseURL = DefaultURL
	}
	client := &http.Client{Timeout: 10 * time.Second}
	data, err := diskcache.FetchBytes(contextWithoutCancel(), client, http.MethodGet, baseURL+"/api.json", nil, 8<<20)
	if err != nil {
		return nil, err
	}
	if cachePath := effectiveCachePath(source.CachePath); cachePath != "" {
		_ = diskcache.File{Path: cachePath}.Write(contextWithoutCancel(), data)
	}
	return NewCatalogFromModelsDevJSON(data)
}

func contextWithoutCancel() context.Context {
	return context.Background()
}
