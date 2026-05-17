package tools

import (
	"net/http"
	"time"

	"blitzcrank/internal/config"
)

type Registry struct {
	cfg  config.Config
	http *http.Client
}

type toolDef struct {
	Name        string
	Description string
	Parameters  map[string]any
	Mutating    bool
	Destructive bool
}

type ToolPolicy struct {
	ReadOnly bool
	Groups   []string
}

func NewRegistry(cfg config.Config) *Registry {
	return &Registry{
		cfg: cfg,
		http: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}
