package tools

import "strings"

func (r *Registry) OpenAITools() []any {
	return r.OpenAIToolsForPolicy(ToolPolicy{})
}

func (r *Registry) OpenAIToolsForPolicy(policy ToolPolicy) []any {
	defs := append([]toolDef{}, baseToolDefs...)
	if strings.TrimSpace(r.cfg.ExaAPIKey) != "" {
		defs = append(defs, toolDef{
			Name:        "web_search",
			Description: "Search the public web for current or external facts using Exa. Use after local media-server tools when an answer depends on outside facts, such as release availability, language/audio-track availability, schedules, or public metadata.",
			Parameters: objectSchema(map[string]any{
				"query": stringSchema("Search query"),
				"limit": numberSchema("Maximum search results to return, from 1 to 10"),
			}, []string{"query"}),
		})
	}
	out := make([]any, 0, len(defs))
	for _, def := range defs {
		if !r.toolAllowed(def, policy) {
			continue
		}
		out = append(out, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        def.Name,
				"description": def.Description,
				"parameters":  def.Parameters,
			},
		})
	}
	return out
}

func (r *Registry) ToolNamesForPolicy(policy ToolPolicy) []string {
	defs := append([]toolDef{}, baseToolDefs...)
	if strings.TrimSpace(r.cfg.ExaAPIKey) != "" {
		defs = append(defs, toolDef{Name: "web_search"})
	}
	names := make([]string, 0, len(defs))
	for _, def := range defs {
		if !r.toolAllowed(def, policy) {
			continue
		}
		names = append(names, def.Name)
	}
	return names
}

func (r *Registry) ToolAllowedForPolicy(name string, policy ToolPolicy) bool {
	def, ok := r.toolDef(name)
	if !ok {
		return false
	}
	return r.toolAllowed(def, policy)
}

func (r *Registry) IsMutatingTool(name string) bool {
	def, ok := r.toolDef(name)
	if !ok {
		return false
	}
	return def.Mutating
}

func (r *Registry) IsDestructiveTool(name string) bool {
	def, ok := r.toolDef(name)
	if !ok {
		return false
	}
	return def.Destructive
}

func (r *Registry) RequiresApproval(name string) bool {
	return r.IsDestructiveTool(name)
}

func (r *Registry) toolAllowed(def toolDef, policy ToolPolicy) bool {
	if policy.ReadOnly && def.Mutating {
		return false
	}
	if len(policy.Groups) == 0 {
		return true
	}
	return groupAllowed(toolGroup(def.Name), policy.Groups)
}

func (r *Registry) toolDef(name string) (toolDef, bool) {
	for _, def := range baseToolDefs {
		if def.Name == name {
			return def, true
		}
	}
	if name == "web_search" && strings.TrimSpace(r.cfg.ExaAPIKey) != "" {
		return toolDef{Name: "web_search"}, true
	}
	return toolDef{}, false
}

func toolGroup(name string) string {
	switch {
	case strings.HasPrefix(name, "seerr_"):
		return "jellyseerr"
	case strings.HasPrefix(name, "jellyfin_"):
		return "jellyfin"
	case strings.HasPrefix(name, "sonarr_"):
		return "sonarr"
	case strings.HasPrefix(name, "radarr_"):
		return "radarr"
	case strings.HasPrefix(name, "sabnzbd_"):
		return "sabnzbd"
	case strings.HasPrefix(name, "fs_"):
		return "filesystem"
	case name == "web_search":
		return "web"
	default:
		return ""
	}
}

func groupAllowed(group string, allowed []string) bool {
	for _, value := range allowed {
		if strings.EqualFold(strings.TrimSpace(value), group) {
			return true
		}
	}
	return false
}
