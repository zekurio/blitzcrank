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
	case strings.HasPrefix(source, "seerr_issue_"):
		return tools.ToolPolicy{Groups: groups, SandboxServices: true}
	case source == "automation_cron" && isStaleImportHandler(req.Content):
		return tools.ToolPolicy{Groups: groups, SandboxServices: true}
	case strings.HasPrefix(source, "discord"):
		return tools.ToolPolicy{Groups: groups, SandboxServices: true}
	default:
		return tools.ToolPolicy{ReadOnly: true, Groups: groups, SandboxServices: true}
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
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(req.Source)), "seerr_issue_") {
		selected = append([]string{"seerr-issue-solver"}, selected...)
	}
	if !requestHasExplicitSkillSelection(req) {
		selected = append(selected, skillNamesMatchingRequest(req.Content, skills)...)
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
		case "seerr", "jellyfin", "sonarr", "radarr", "sabnzbd", "filesystem":
			names = append(names, group)
		}
	}
	return uniqueStrings(names)
}

func requestHasExplicitSkillSelection(req Request) bool {
	source := strings.ToLower(strings.TrimSpace(req.Source))
	return len(req.ToolGroups) > 0 && strings.Contains(source, "slash")
}

func skillNamesMatchingRequest(content string, skills []Skill) []string {
	text := normalizedCapabilityText(content)
	if text == "" {
		return nil
	}
	var names []string
	for _, skill := range skills {
		name := strings.TrimSpace(skill.Name)
		if name == "" || isBuiltInSkillGroup(name) {
			continue
		}
		if skillMatchesText(skill, text) {
			names = append(names, name)
		}
	}
	return uniqueStrings(names)
}

func isBuiltInSkillGroup(name string) bool {
	for _, selected := range skillNamesForGroups([]string{name}) {
		if selected == name {
			return true
		}
	}
	return false
}

func skillMatchesText(skill Skill, text string) bool {
	name := strings.TrimSpace(skill.Name)
	if name != "" && phraseInText(normalizedCapabilityText(name), text) {
		return true
	}
	description := normalizedCapabilityText(skill.Description)
	for _, token := range strings.Fields(description) {
		if len(token) < 4 || commonSkillCatalogToken(token) {
			continue
		}
		if phraseInText(token, text) {
			return true
		}
	}
	return false
}

func phraseInText(phrase, text string) bool {
	phrase = strings.TrimSpace(phrase)
	if phrase == "" {
		return false
	}
	return strings.Contains(" "+text+" ", " "+phrase+" ")
}

func commonSkillCatalogToken(token string) bool {
	switch token {
	case "skill", "workflow", "workflows", "support", "agent", "agents", "tool", "tools", "with", "when", "from", "that", "this", "use", "uses", "using", "create", "update", "delete", "search", "list", "durable", "markdown", "operational", "facts":
		return true
	default:
		return false
	}
}

func (a *Agent) toolGroupsForRequest(req Request) []string {
	if len(req.ToolGroups) > 0 {
		return uniqueStrings(append(req.ToolGroups, "sandbox", "web", "history"))
	}
	source := strings.ToLower(strings.TrimSpace(req.Source))
	if strings.HasPrefix(source, "seerr_issue_") {
		return []string{"sandbox", "seerr", "jellyfin", "sonarr", "radarr", "sabnzbd", "filesystem", "web", "history"}
	}
	if source == "automation_cron" {
		return []string{"sandbox", "seerr", "jellyfin", "sonarr", "radarr", "sabnzbd", "filesystem", "web", "history"}
	}

	text := normalizedCapabilityText(req.Content)
	groups := make([]string, 0, 7)
	addGroup := func(name string) {
		groups = append(groups, name)
	}
	if containsAny(text, "seerr", "request", "issue") {
		addGroup("seerr")
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
		return []string{"sandbox", "seerr", "jellyfin", "web", "history"}
	}
	return uniqueStrings(append(groups, "sandbox", "web", "history"))
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
	case strings.HasPrefix(source, "seerr_issue_"):
		return "Active workflow: Seerr issue. Follow the Seerr issue workflow and final-comment rules. If a tool review blocks or questions a proposed sandbox call, gather missing read-only evidence or narrow the script before escalating to an admin; escalate only when evidence is complete and the remaining risk needs a human decision. " + mutation
	case source == "automation_cron":
		return "Active workflow: scheduled automation. Follow the automation prompt for output shape. Ignore Seerr issue final-comment rules unless the automation explicitly concerns a Seerr issue. If a mutating tool call is challenged, use reviewer feedback to narrow the target, gather read-only evidence, or report a manual-review item instead of escalating by default. " + mutation
	case strings.HasPrefix(source, "discord"):
		return "Active workflow: Discord support. Reply as a Discord message. Ignore Seerr issue final-comment rules unless the user explicitly asks about a Seerr issue. For new acquisition requests such as asking to add, request, get, track, or monitor a movie or show for a user, prefer Seerr request tools first so permissions and quotas are checked before downstream services are mutated. Use direct Sonarr/Radarr maintenance tools for operational repair of content that already exists downstream. Non-delete write tools may be used directly only when evidence clearly supports the action; validate with follow-up reads after any mutation. If you are not confident a non-delete write is safe, gather more read-only evidence or narrow the call before asking the owner/admin for approval with a compact description of the intended tool call. Delete tools require owner/admin approval before execution; when you call one, the runtime will post an approval request and wait for a thumbs-up or thumbs-down reaction. " + mutation
	default:
		return "Active workflow: general media-server support. Ignore Seerr issue final-comment rules unless the request explicitly concerns a Seerr issue. " + mutation
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
	if policyIncludesGroup(policy, "history") && containsString(names, "thread_history_search") {
		lines = append(lines, "thread_history_search is available for finding compact snippets from prior agent threads. Use it early for repeated symptoms, reopened Seerr issues, stale imports, ambiguous media titles, recurring automation blockers, or when the user says the problem happened again, is still happening, was already checked, or matches a prior case. Choose focused queries with the title plus symptom, for example a show name and 'stale import' or 'missing German audio'. Treat its results as historical hints, not current truth; use live service checks before claiming or changing current server state. For non-admin or Seerr issue audiences, use history only for technical/media context, never to expose other users' identities, private history, request history, watch history, or prior-thread snippets in the final reply.")
	}
	if policy.SandboxServices && containsString(names, "sandbox_run_typescript") {
		lines = append(lines, "Service APIs are inspected through sandbox_run_typescript instead of one-off service tools. Write short Deno TypeScript diagnostics with a clear purpose; the runtime reviews the script and grants only the needed service permissions before execution.")
		lines = append(lines, "Sandbox service environment variables are canonical and exact: SEERR_BASE_URL/SEERR_API_KEY, JELLYFIN_BASE_URL/JELLYFIN_API_KEY, SONARR_BASE_URL/SONARR_API_KEY, RADARR_BASE_URL/RADARR_API_KEY, SABNZBD_BASE_URL/SABNZBD_API_KEY, and BOT_TIMEZONE. Do not read fallback or alternate names such as SONARR_URL, because Deno rejects reads for env names that were not granted.")
		lines = append(lines, "When calling sandbox_run_typescript, include safety_level and safety_reason whenever the script is mutating or operationally sensitive. Argue the narrowest safety case you believe applies: exact target, evidence already gathered, why the permissions are minimal, why read-only alternatives are insufficient, and whether admin escalation should or should not be needed. The sandbox reviewer will independently challenge it; if challenged, use that counterargument to gather evidence or narrow the call before escalating.")
	}
	if policy.ReadOnly {
		lines = append(lines, "This selected set is read-only for media-server operations; repair and queue mutation tools are omitted.")
	} else if policyIncludesGroup(policy, "seerr") || policyIncludesGroup(policy, "jellyfin") || policyIncludesGroup(policy, "sonarr") || policyIncludesGroup(policy, "radarr") {
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
	case strings.HasPrefix(name, "sandbox_"):
		return "sandbox"
	case name == "web_search":
		return "web"
	case strings.HasPrefix(name, "thread_history_"):
		return "history"
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
