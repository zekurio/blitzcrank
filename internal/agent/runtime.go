package agent

import (
	"strings"

	"blitzcrank/internal/config"
	"blitzcrank/internal/llm"
	"blitzcrank/internal/tools"
)

func (a *Agent) discordTriageModel() string {
	cfg := a.configSnapshot()
	return strings.TrimSpace(cfg.RuntimeProfile("discord_triage").Model)
}

func (a *Agent) discordTriageReasoningEffort() string {
	cfg := a.configSnapshot()
	return strings.TrimSpace(cfg.RuntimeProfile("discord_triage").ReasoningEffort)
}

func (a *Agent) clientForRequest(req Request) (llm.Client, error) {
	_, client, _, _, err := a.runtimeForRequest(req)
	return client, err
}

func (a *Agent) clientForProfile(name string) (llm.Client, error) {
	_, client, _, _, err := a.runtimeForProfile(name)
	return client, err
}

func (a *Agent) runtimeForRequest(req Request) (config.Config, llm.Client, string, string, error) {
	return a.runtimeForProfile(a.profileNameForRequest(req))
}

func (a *Agent) runtimeForProfile(name string) (config.Config, llm.Client, string, string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "default"
	}
	a.clientMu.Lock()
	defer a.clientMu.Unlock()
	cfg := a.cfg
	profile := cfg.RuntimeProfile(name)
	model := strings.TrimSpace(profile.Model)
	reasoningEffort := ReasoningEffortForRequest(profile.ReasoningEffort, model)
	if a.clients == nil {
		a.clients = map[string]llm.Client{}
		if a.client != nil {
			a.clients["default"] = a.client
		}
	}
	if client, ok := a.clients[name]; ok {
		return cfg, client, model, reasoningEffort, nil
	}
	if a.client != nil && len(cfg.RuntimeProfiles) == 0 {
		return cfg, a.client, model, reasoningEffort, nil
	}
	client, err := llm.New(cfg.WithRuntimeProfile(profile))
	if err != nil {
		return cfg, nil, model, reasoningEffort, err
	}
	a.clients[name] = client
	return cfg, client, model, reasoningEffort, nil
}

func (a *Agent) configSnapshot() config.Config {
	a.clientMu.Lock()
	defer a.clientMu.Unlock()
	return a.cfg
}

func (a *Agent) profileNameForRequest(req Request) string {
	source := strings.TrimSpace(req.Source)
	switch {
	case source == "automation_cron":
		return "automation"
	case strings.HasPrefix(source, "discord"):
		return "discord"
	case strings.HasPrefix(source, "seerr"):
		return "seerr"
	default:
		return "default"
	}
}

func (a *Agent) ModelName(req Request) string {
	cfg := a.configSnapshot()
	return strings.TrimSpace(cfg.RuntimeProfile(a.profileNameForRequest(req)).Model)
}

func (a *Agent) ReasoningEffort(req Request, model string) string {
	cfg := a.configSnapshot()
	return ReasoningEffortForRequest(cfg.RuntimeProfile(a.profileNameForRequest(req)).ReasoningEffort, model)
}

func (a *Agent) RuntimeInfo(req Request) (string, string) {
	cfg := a.configSnapshot()
	profile := cfg.RuntimeProfile(a.profileNameForRequest(req))
	model := strings.TrimSpace(profile.Model)
	return model, ReasoningEffortForRequest(profile.ReasoningEffort, model)
}

func (a *Agent) ToolNames(req Request) []string {
	return a.registry.ToolNamesForPolicy(a.toolPolicy(req))
}

func (a *Agent) MutatingToolNames() []string {
	readOnlyNames := a.registry.ToolNamesForPolicy(tools.ToolPolicy{ReadOnly: true})
	readOnly := make(map[string]bool, len(readOnlyNames))
	for _, name := range readOnlyNames {
		readOnly[name] = true
	}
	allNames := a.registry.ToolNamesForPolicy(tools.ToolPolicy{})
	names := make([]string, 0, len(allNames))
	for _, name := range allNames {
		if !readOnly[name] {
			names = append(names, name)
		}
	}
	return names
}

func ReasoningEffortForRequest(fallback, model string) string {
	if strings.TrimSpace(fallback) != "" {
		return strings.TrimSpace(fallback)
	}
	return RecommendedReasoningEffort(model)
}

func RecommendedReasoningEffort(model string) string {
	model = normalizedModelName(model)
	switch {
	case model == "gpt-5.4-mini" || strings.HasPrefix(model, "gpt-5.4-mini-"):
		return "high"
	case model == "gpt-5.4" || strings.HasPrefix(model, "gpt-5.4-"):
		return "medium"
	case model == "gpt-5.5" || strings.HasPrefix(model, "gpt-5.5-"):
		return "low"
	default:
		return ""
	}
}

func normalizedModelName(model string) string {
	model = strings.ToLower(strings.TrimSpace(model))
	if _, suffix, ok := strings.Cut(model, "/"); ok {
		model = suffix
	}
	if prefix, _, ok := strings.Cut(model, ":"); ok {
		model = prefix
	}
	return model
}
