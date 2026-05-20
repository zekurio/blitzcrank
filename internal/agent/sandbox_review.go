package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"strings"

	"blitzcrank/internal/llm"
	"blitzcrank/internal/tools"
)

type sandboxReviewDecision struct {
	Decision    string                   `json:"decision"`
	Reason      string                   `json:"reason"`
	Mutating    bool                     `json:"mutating"`
	Permissions tools.SandboxPermissions `json:"permissions"`
}

type sandboxSafetyProposal struct {
	Level  string
	Reason string
}

func (a *Agent) reviewSandboxTool(ctx context.Context, req Request, args map[string]any, policy tools.ToolPolicy) error {
	script := strings.TrimSpace(toolArgString(args, "script"))
	purpose := strings.TrimSpace(toolArgString(args, "purpose"))
	proposal := sandboxSafetyProposal{
		Level:  strings.TrimSpace(toolArgString(args, "safety_level")),
		Reason: strings.TrimSpace(toolArgString(args, "safety_reason")),
	}
	if script == "" || purpose == "" {
		return nil
	}
	if err := validateSandboxScriptPreflight(req, script); err != nil {
		return err
	}
	review, err := a.sandboxReview(ctx, req, purpose, script, proposal)
	if err != nil {
		return err
	}
	review.Decision = strings.ToLower(strings.TrimSpace(review.Decision))
	servicePermissions := a.registry.SandboxServicePermissions()
	referencedPermissions := a.registry.SandboxReferencedPermissions(script)
	review.Permissions = restrictSandboxPermissions(review.Permissions, servicePermissions)
	review.Permissions = addReferencedAllowedEnv(review.Permissions, servicePermissions, script)
	review.Permissions = addReferencedAllowedNet(review.Permissions, referencedPermissions)
	if policy.ReadOnly && review.Mutating {
		return fmt.Errorf("sandbox script was classified as mutating and is not permitted in read-only source policy: %s", review.Reason)
	}
	switch review.Decision {
	case "allow":
	case "ask":
		if automationMayRunReviewedSandboxMutation(req, policy, purpose, script, review) {
			review.Decision = "allow"
			break
		}
		if req.ToolApproval == nil {
			return fmt.Errorf("sandbox script requires approval, but no approval callback is available: %s", review.Reason)
		}
		decision, err := req.ToolApproval(ctx, ToolApprovalRequest{
			Name:             "sandbox_run_typescript",
			Mutating:         review.Mutating,
			Destructive:      review.Mutating,
			ArgumentsSummary: compactLogValue(map[string]any{"purpose": purpose, "safety_level": proposal.Level, "safety_reason": proposal.Reason, "review": review}, 2000),
		})
		if err != nil {
			return err
		}
		if !decision.Approved {
			reason := strings.TrimSpace(decision.Reason)
			if reason == "" {
				reason = "sandbox script was denied"
			}
			if actor := strings.TrimSpace(decision.Actor); actor != "" {
				return fmt.Errorf("%s by %s", reason, actor)
			}
			return fmt.Errorf("%s", reason)
		}
	case "deny":
		return fmt.Errorf("sandbox script denied by review: %s", review.Reason)
	default:
		return fmt.Errorf("sandbox review returned invalid decision %q", review.Decision)
	}
	review.Permissions = addAllowedEnvNames(review.Permissions, referencedPermissions.AllowEnv)
	review.Permissions = addReferencedAllowedNet(review.Permissions, referencedPermissions)
	args["_sandbox_permissions"] = review.Permissions
	return nil
}

func (a *Agent) sandboxReview(ctx context.Context, req Request, purpose, script string, proposal sandboxSafetyProposal) (sandboxReviewDecision, error) {
	client, err := a.clientForProfile("sandbox_review")
	if err != nil {
		return sandboxReviewDecision{}, err
	}
	cfg := a.configSnapshot()
	profile := cfg.RuntimeProfile("sandbox_review")
	model := strings.TrimSpace(profile.Model)
	effort := ReasoningEffortForRequest(profile.ReasoningEffort, model)
	servicePermissions := a.registry.SandboxServicePermissions()
	template, err := LoadPromptTemplate(sandboxReviewPromptPath)
	if err != nil {
		return sandboxReviewDecision{}, err
	}
	prompt := strings.NewReplacer(
		"{{allowed_net}}", fmt.Sprint(servicePermissions.AllowNet),
		"{{allowed_env}}", fmt.Sprint(servicePermissions.AllowEnv),
		"{{allowed_read}}", fmt.Sprint(servicePermissions.AllowRead),
		"{{request_source}}", req.Source,
		"{{request_author}}", req.Author,
		"{{requester_id}}", nonEmptyMetadata(req.AuthorID),
		"{{requester_admin}}", fmt.Sprintf("%t", req.IsAdmin),
		"{{audience}}", requestAudience(req),
		"{{seerr_user_id}}", nonEmptyMetadata(req.SeerrUserID),
		"{{purpose}}", purpose,
		"{{safety_level}}", nonEmptyMetadata(proposal.Level),
		"{{safety_reason}}", nonEmptyMetadata(proposal.Reason),
		"{{script}}", script,
	).Replace(template)
	response, err := client.Chat(ctx, llm.ChatRequest{
		Model:           model,
		ReasoningEffort: effort,
		Messages: []llm.Message{
			{Role: "system", Content: "You are a strict security reviewer for Deno sandbox permissions. Return JSON only."},
			{Role: "user", Content: prompt},
		},
	})
	if err != nil {
		return sandboxReviewDecision{}, err
	}
	content := strings.TrimSpace(response.FirstChoice().Message.Content)
	var review sandboxReviewDecision
	if err := json.Unmarshal([]byte(content), &review); err != nil {
		return sandboxReviewDecision{}, fmt.Errorf("parse sandbox review JSON: %w: %s", err, compactLogString(content, 500))
	}
	return review, nil
}

func restrictSandboxPermissions(requested, allowed tools.SandboxPermissions) tools.SandboxPermissions {
	return tools.SandboxPermissions{
		AllowNet:   intersectNetPermissions(requested.AllowNet, allowed.AllowNet),
		AllowEnv:   intersectStrings(requested.AllowEnv, allowed.AllowEnv),
		AllowRead:  intersectStrings(requested.AllowRead, allowed.AllowRead),
		AllowWrite: nil,
	}
}

func validateSandboxScriptPreflight(req Request, script string) error {
	compact := strings.ToLower(strings.Join(strings.Fields(script), " "))
	blocked := []string{
		"deno.env.toobject",
		"object.keys(deno.env",
		"object.entries(deno.env",
		"object.values(deno.env",
		"console.log(deno.env",
		"console.error(deno.env",
		"console.warn(deno.env",
	}
	for _, pattern := range blocked {
		if strings.Contains(compact, pattern) {
			return fmt.Errorf("sandbox script may not enumerate or print environment variables; use documented configured env names")
		}
	}
	if requestAudienceIsRestricted(req) && sandboxScriptHasPrivateEnumeration(compact, req) {
		return fmt.Errorf("sandbox script may not enumerate users, sessions, history, or broad private records for non-admin requesters")
	}
	return nil
}

func requestAudienceIsRestricted(req Request) bool {
	switch requestAudience(req) {
	case "non_admin", "seerr_issue":
		return !req.IsAdmin
	default:
		return false
	}
}

func automationMayRunReviewedSandboxMutation(req Request, policy tools.ToolPolicy, purpose, script string, review sandboxReviewDecision) bool {
	if policy.ReadOnly || !review.Mutating {
		return false
	}
	if strings.ToLower(strings.TrimSpace(req.Source)) != "automation_cron" || requestAudience(req) != "automation" {
		return false
	}
	if !isStaleImportHandler(req.Content) {
		return false
	}
	if len(review.Permissions.AllowWrite) > 0 || len(review.Permissions.AllowRead) > 0 {
		return false
	}
	compact := strings.ToLower(strings.Join(strings.Fields(purpose+" "+script), " "))
	if !strings.Contains(compact, "sonarr") && !strings.Contains(compact, "radarr") {
		return false
	}
	for _, blocked := range []string{
		"moviessearch",
		"episodesearch",
		"seasonsearch",
		"seriessearch",
		"refreshmovie",
		"refreshseries",
		"/api/v3/blocklist/",
	} {
		if strings.Contains(compact, blocked) {
			return false
		}
	}
	if strings.Contains(compact, "manualimport") {
		return true
	}
	return strings.Contains(compact, "/api/v3/queue/") &&
		strings.Contains(compact, "delete") &&
		strings.Contains(compact, "removefromclient=true") &&
		strings.Contains(compact, "blocklist=true")
}

func sandboxScriptHasPrivateEnumeration(compact string, req Request) bool {
	patterns := []string{
		"/users",
		"/sessions",
		"/playingitems",
		"/playeditems",
		"/activitylog",
		"/api/v1/user?",
		"/api/v1/user`",
		"'/api/v1/user'",
		"\"/api/v1/user\"",
		"/api/v1/issue?",
		"/api/v1/request?",
	}
	for _, pattern := range patterns {
		if strings.Contains(compact, pattern) {
			return true
		}
	}
	seerrUserID := strings.TrimSpace(req.SeerrUserID)
	if seerrUserID != "" && strings.Contains(compact, "/api/v1/user/") && !strings.Contains(compact, seerrUserID) {
		return true
	}
	return false
}

func addReferencedAllowedEnv(permissions, allowed tools.SandboxPermissions, script string) tools.SandboxPermissions {
	seen := make(map[string]bool, len(permissions.AllowEnv))
	for _, value := range permissions.AllowEnv {
		seen[strings.TrimSpace(value)] = true
	}
	for _, env := range allowed.AllowEnv {
		env = strings.TrimSpace(env)
		if env == "" || seen[env] || !scriptReferencesEnvName(script, env) {
			continue
		}
		permissions.AllowEnv = append(permissions.AllowEnv, env)
		seen[env] = true
	}
	return permissions
}

func addAllowedEnvNames(permissions tools.SandboxPermissions, envNames []string) tools.SandboxPermissions {
	seen := make(map[string]bool, len(permissions.AllowEnv))
	for _, value := range permissions.AllowEnv {
		seen[strings.TrimSpace(value)] = true
	}
	for _, env := range envNames {
		env = strings.TrimSpace(env)
		if env == "" || seen[env] {
			continue
		}
		permissions.AllowEnv = append(permissions.AllowEnv, env)
		seen[env] = true
	}
	return permissions
}

func scriptReferencesEnvName(script, env string) bool {
	for offset := 0; ; {
		index := strings.Index(script[offset:], env)
		if index < 0 {
			return false
		}
		start := offset + index
		end := start + len(env)
		if isEnvNameBoundary(script, start-1) && isEnvNameBoundary(script, end) {
			return true
		}
		offset = end
	}
}

func isEnvNameBoundary(value string, index int) bool {
	if index < 0 || index >= len(value) {
		return true
	}
	ch := value[index]
	return !(ch == '_' || ch >= 'A' && ch <= 'Z' || ch >= 'a' && ch <= 'z' || ch >= '0' && ch <= '9')
}

func addReferencedAllowedNet(permissions, referenced tools.SandboxPermissions) tools.SandboxPermissions {
	seen := make(map[string]bool, len(permissions.AllowNet))
	for _, value := range permissions.AllowNet {
		seen[strings.TrimSpace(value)] = true
	}
	for _, host := range referenced.AllowNet {
		host = strings.TrimSpace(host)
		if host == "" || seen[host] {
			continue
		}
		permissions.AllowNet = append(permissions.AllowNet, host)
		seen[host] = true
	}
	return permissions
}

func intersectNetPermissions(values, allowed []string) []string {
	allowedByKey := make(map[string]string, len(allowed)*2)
	for _, value := range allowed {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		allowedByKey[value] = value
		if host := netPermissionHostname(value); host != "" {
			allowedByKey[host] = value
		}
	}
	out := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		for _, key := range netPermissionKeys(value) {
			allowedValue, ok := allowedByKey[key]
			if !ok || seen[allowedValue] {
				continue
			}
			seen[allowedValue] = true
			out = append(out, allowedValue)
			break
		}
	}
	return out
}

func netPermissionKeys(value string) []string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	keys := []string{value}
	if parsed, err := url.Parse(value); err == nil && parsed.Host != "" {
		keys = append(keys, parsed.Host)
	}
	if host := netPermissionHostname(value); host != "" {
		keys = append(keys, host)
	}
	return keys
}

func netPermissionHostname(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if parsed, err := url.Parse(value); err == nil && parsed.Host != "" {
		value = parsed.Host
	}
	if host, _, err := net.SplitHostPort(value); err == nil {
		return strings.Trim(host, "[]")
	}
	if strings.Count(value, ":") > 1 {
		return strings.Trim(value, "[]")
	}
	host, _, found := strings.Cut(value, ":")
	if found {
		return host
	}
	return value
}

func intersectStrings(values, allowed []string) []string {
	allowedSet := make(map[string]bool, len(allowed))
	for _, value := range allowed {
		allowedSet[strings.TrimSpace(value)] = true
	}
	out := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || !allowedSet[value] || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}
