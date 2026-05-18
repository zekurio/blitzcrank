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
	Name            string
	Description     string
	Parameters      map[string]any
	Mutating        bool
	Destructive     bool
	ReadOnlyAllowed bool
}

type SandboxPermissions struct {
	AllowNet   []string `json:"allow_net,omitempty"`
	AllowEnv   []string `json:"allow_env,omitempty"`
	AllowRead  []string `json:"allow_read,omitempty"`
	AllowWrite []string `json:"allow_write,omitempty"`
}

type ToolPolicy struct {
	ReadOnly        bool
	Groups          []string
	SandboxServices bool
}

func NewRegistry(cfg config.Config) *Registry {
	return &Registry{
		cfg: cfg,
		http: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}
