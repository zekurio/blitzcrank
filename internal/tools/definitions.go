package tools

import "strings"

func (r *Registry) OpenAITools() []any {
	return r.OpenAIToolsForPolicy(ToolPolicy{})
}

func (r *Registry) OpenAIToolsForPolicy(policy ToolPolicy) []any {
	defs := append([]toolDef{}, baseToolDefs...)
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
	names := make([]string, 0, len(baseToolDefs))
	for _, def := range baseToolDefs {
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
	return ok && def.Mutating
}

func (r *Registry) IsDestructiveTool(name string) bool {
	def, ok := r.toolDef(name)
	return ok && def.Destructive
}

func (r *Registry) RequiresApproval(name string) bool { return r.IsDestructiveTool(name) }

func (r *Registry) AllowedInReadOnly(name string) bool {
	def, ok := r.toolDef(name)
	return ok && def.ReadOnlyAllowed
}

func (r *Registry) toolAllowed(def toolDef, policy ToolPolicy) bool {
	if policy.ReadOnly && def.Mutating && !def.ReadOnlyAllowed {
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
	return toolDef{}, false
}

func toolGroup(name string) string {
	switch {
	case strings.HasPrefix(name, "seerr_"):
		return "seerr"
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
	case strings.HasPrefix(name, "thread_history_"):
		return "history"
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

func isServiceToolGroup(group string) bool {
	switch group {
	case "seerr", "jellyfin", "sonarr", "radarr", "sabnzbd", "filesystem":
		return true
	default:
		return false
	}
}
