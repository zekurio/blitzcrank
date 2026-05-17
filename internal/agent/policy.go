package agent

import (
	"fmt"
	"strings"

	"blitzcrank/internal/tools"
)

func (a *Agent) toolPolicy(req Request) tools.ToolPolicy {
	source := strings.ToLower(strings.TrimSpace(req.Source))
	groups := a.toolGroupsForRequest(req)
	switch {
	case strings.HasPrefix(source, "jellyseerr_issue_"):
		return tools.ToolPolicy{Groups: groups}
	case source == "automation_cron" && isStaleImportHandler(req.Content):
		return tools.ToolPolicy{Groups: groups}
	case strings.HasPrefix(source, "discord"):
		return tools.ToolPolicy{Groups: groups}
	default:
		return tools.ToolPolicy{ReadOnly: true, Groups: groups}
	}
}

func isStaleImportHandler(content string) bool {
	text := normalizedCapabilityText(content)
	return strings.Contains(text, "hourly stale import handler") ||
		strings.Contains(text, "hourly-stale-import-handler")
}

func (a *Agent) skillsForRequest(req Request) []Skill {
	a.mu.RLock()
	skills := append([]Skill(nil), a.skills...)
	a.mu.RUnlock()
	return skillsForRequest(req, skills, a.toolGroupsForRequest(req))
}

func skillsForRequest(req Request, skills []Skill, groups []string) []Skill {
	selected := skillNamesForGroups(groups)
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(req.Source)), "jellyseerr_issue_") {
		selected = append([]string{"seerr-issue-solver"}, selected...)
	}
	selectedSet := make(map[string]bool, len(selected))
	for _, name := range selected {
		selectedSet[name] = true
	}
	out := make([]Skill, 0, len(selectedSet))
	for _, skill := range skills {
		if selectedSet[skill.Name] {
			out = append(out, skill)
		}
	}
	return out
}

func skillNamesForGroups(groups []string) []string {
	names := make([]string, 0, len(groups))
	for _, group := range groups {
		switch group {
		case "jellyseerr", "jellyfin", "sonarr", "radarr", "sabnzbd", "filesystem":
			names = append(names, group)
		}
	}
	return uniqueStrings(names)
}

func (a *Agent) toolGroupsForRequest(req Request) []string {
	if len(req.ToolGroups) > 0 {
		return uniqueStrings(append(req.ToolGroups, "web"))
	}
	source := strings.ToLower(strings.TrimSpace(req.Source))
	if strings.HasPrefix(source, "jellyseerr_issue_") {
		return []string{"jellyseerr", "jellyfin", "sonarr", "radarr", "sabnzbd", "filesystem", "web"}
	}
	if source == "automation_cron" {
		return []string{"jellyseerr", "jellyfin", "sonarr", "radarr", "sabnzbd", "filesystem", "web"}
	}

	text := normalizedCapabilityText(req.Content)
	groups := make([]string, 0, 7)
	addGroup := func(name string) {
		groups = append(groups, name)
	}
	if containsAny(text, "jellyseerr", "overseerr", "seerr", "request", "issue") {
		addGroup("jellyseerr")
	}
	if containsAny(text, "jellyfin", "library", "libraries", "playback", "watched", "played", "user", "users", "view", "views", "subtitle", "subtitles", "untertitel", "audio", "tonspur", "verfuegbar", "available") {
		addGroup("jellyfin")
	}
	if containsAny(text, "sonarr", "series", "season", "episode", "tvdb", "serie", "staffel", "folge", "s0") {
		addGroup("sonarr")
	}
	if containsAny(text, "radarr", "movie", "film", "tmdb") {
		addGroup("radarr")
	}
	if containsAny(text, "sabnzbd", "sab", "download", "queue", "blocklist", "import", "stuck", "failed", "haengt", "fehler") {
		addGroup("sabnzbd")
	}
	if containsAny(text, "disk", "filesystem", "file", "path", "permissions", "folder", "directory", "speicher", "datei", "ordner", "import", "completed") {
		addGroup("filesystem")
	}
	if containsAny(text, "release", "released", "streaming", "public", "availability", "available", "verfuegbar", "wann", "when", "raus", "erscheint", "premiere", "anime") {
		addGroup("web")
	}
	if len(groups) == 0 && strings.HasPrefix(source, "discord") {
		return []string{"jellyseerr", "jellyfin", "web"}
	}
	return uniqueStrings(append(groups, "web"))
}

func normalizedCapabilityText(content string) string {
	text := strings.ToLower(strings.TrimSpace(content))
	text = strings.NewReplacer("ä", "ae", "ö", "oe", "ü", "ue", "ß", "ss").Replace(text)
	return strings.Join(strings.Fields(text), " ")
}

func containsAny(text string, needles ...string) bool {
	for _, needle := range needles {
		if strings.Contains(text, needle) {
			return true
		}
	}
	return false
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func (a *Agent) workflowPrompt(req Request, policy tools.ToolPolicy) string {
	source := strings.ToLower(strings.TrimSpace(req.Source))
	mutation := "Mutating tools are available only when the active workflow and evidence allow them."
	if policy.ReadOnly {
		mutation = "This run is read-only: use lookup/search tools only, do not attempt repairs, refreshes, retries, searches that alter queues, deletes, or issue resolution."
	}
	switch {
	case strings.HasPrefix(source, "jellyseerr_issue_"):
		return "Active workflow: Jellyseerr issue. Follow the Jellyseerr issue workflow and final-comment rules. " + mutation
	case source == "automation_cron":
		return "Active workflow: scheduled automation. Follow the automation prompt for output shape. Ignore Jellyseerr issue final-comment rules unless the automation explicitly concerns a Jellyseerr issue. " + mutation
	case strings.HasPrefix(source, "discord"):
		return "Active workflow: Discord support. Reply as a Discord message. Ignore Jellyseerr issue final-comment rules unless the user explicitly asks about a Jellyseerr issue. For new acquisition requests such as asking to add, request, get, track, or monitor a movie or show for a user, prefer Jellyseerr request tools first so permissions and quotas are checked before downstream services are mutated. Use direct Sonarr/Radarr maintenance tools for operational repair of content that already exists downstream. Non-delete write tools may be used directly only when evidence clearly supports the action; validate with follow-up reads after any mutation. If you are not confident a non-delete write is safe, do not mutate yet and instead ask the owner/admin for approval with a compact description of the intended tool call. Delete tools require owner/admin approval before execution; when you call one, the runtime will post an approval request and wait for a thumbs-up or thumbs-down reaction. " + mutation
	default:
		return "Active workflow: general media-server support. Ignore Jellyseerr issue final-comment rules unless the request explicitly concerns a Jellyseerr issue. " + mutation
	}
}

func (a *Agent) toolContextPrompt(policy tools.ToolPolicy) string {
	names := a.registry.ToolNamesForPolicy(policy)
	lines := []string{
		"Tool availability: callable tools are provided through the tool API for this run. Treat them as available capabilities, not a checklist; call a tool only when it materially reduces uncertainty or is required to act.",
	}
	if len(names) == 0 {
		lines = append(lines, "No callable tools are currently configured for the selected capability set.")
	} else {
		lines = append(lines, "Selected tools by capability: "+formatToolCapabilities(names)+".")
	}
	if policyIncludesGroup(policy, "web") {
		if containsString(names, "web_search") {
			lines = append(lines, "web_search is always kept in the selected capability set when configured; prefer it for public or current facts that local media-server tools cannot verify, and cite compact sources when it supports the answer.")
		} else {
			lines = append(lines, "Web search is part of the default capability set, but no callable web_search tool is configured in this run; do not claim web verification.")
		}
	}
	if policy.ReadOnly {
		lines = append(lines, "This selected set is read-only; mutating tools are omitted from the tool API.")
	} else if policyIncludesGroup(policy, "jellyseerr") || policyIncludesGroup(policy, "jellyfin") || policyIncludesGroup(policy, "sonarr") || policyIncludesGroup(policy, "radarr") {
		lines = append(lines, "Mutating tools are present in this selected set. For Discord workflows, use non-delete writes only when evidence is strong, and expect delete tools to pause for owner/admin approval.")
	}
	return strings.Join(lines, " ")
}

func formatToolCapabilities(names []string) string {
	groups := make(map[string][]string, len(names))
	order := make([]string, 0, len(names))
	for _, name := range names {
		group := toolCapabilityGroup(name)
		if _, ok := groups[group]; !ok {
			order = append(order, group)
		}
		groups[group] = append(groups[group], name)
	}
	parts := make([]string, 0, len(order))
	for _, group := range order {
		parts = append(parts, fmt.Sprintf("%s (%s)", group, strings.Join(groups[group], ", ")))
	}
	return strings.Join(parts, "; ")
}

func toolCapabilityGroup(name string) string {
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
		return "other"
	}
}

func policyIncludesGroup(policy tools.ToolPolicy, group string) bool {
	if len(policy.Groups) == 0 {
		return true
	}
	for _, value := range policy.Groups {
		if strings.EqualFold(strings.TrimSpace(value), group) {
			return true
		}
	}
	return false
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
