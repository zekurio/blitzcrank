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

func (a *Agent) reviewSandboxTool(ctx context.Context, req Request, args map[string]any, policy tools.ToolPolicy) error {
	script := strings.TrimSpace(toolArgString(args, "script"))
	purpose := strings.TrimSpace(toolArgString(args, "purpose"))
	if script == "" || purpose == "" {
		return nil
	}
	if err := validateSandboxScriptPreflight(req, script); err != nil {
		return err
	}
	review, err := a.sandboxReview(ctx, req, purpose, script)
	if err != nil {
		return err
	}
	review.Decision = strings.ToLower(strings.TrimSpace(review.Decision))
	servicePermissions := a.registry.SandboxServicePermissions()
	review.Permissions = restrictSandboxPermissions(review.Permissions, servicePermissions)
	review.Permissions = addReferencedAllowedEnv(review.Permissions, servicePermissions, script)
	review.Permissions = addReferencedAllowedNet(review.Permissions, a.registry.SandboxReferencedPermissions(script))
	if policy.ReadOnly && review.Mutating {
		return fmt.Errorf("sandbox script was classified as mutating and is not permitted in read-only source policy: %s", review.Reason)
	}
	switch review.Decision {
	case "allow":
	case "ask":
		if req.ToolApproval == nil {
			return fmt.Errorf("sandbox script requires approval, but no approval callback is available: %s", review.Reason)
		}
		decision, err := req.ToolApproval(ctx, ToolApprovalRequest{
			Name:             "sandbox_run_typescript",
			Mutating:         review.Mutating,
			Destructive:      review.Mutating,
			ArgumentsSummary: compactLogValue(map[string]any{"purpose": purpose, "review": review}, 2000),
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
	args["_sandbox_permissions"] = review.Permissions
	return nil
}

func (a *Agent) sandboxReview(ctx context.Context, req Request, purpose, script string) (sandboxReviewDecision, error) {
	client, err := a.clientForProfile("sandbox_review")
	if err != nil {
		return sandboxReviewDecision{}, err
	}
	cfg := a.configSnapshot()
	profile := cfg.RuntimeProfile("sandbox_review")
	model := strings.TrimSpace(profile.Model)
	effort := ReasoningEffortForRequest(profile.ReasoningEffort, model)
	servicePermissions := a.registry.SandboxServicePermissions()
	prompt := fmt.Sprintf(`You review Deno TypeScript scripts before execution inside a media-server support agent.

Return only compact JSON matching:
{"decision":"allow|ask|deny","reason":"short reason","mutating":false,"permissions":{"allow_net":[],"allow_env":[],"allow_read":[],"allow_write":[]}}

Rules:
- allow read-only diagnostic scripts that fetch or inspect configured services and print concise evidence.
- do not ask merely because a script reads allowed configured base URLs/API keys or contacts allowed configured service hosts.
- ask for approval only if the script may mutate service state, delete data, write outside temporary diagnostics, or otherwise has operational risk.
- deny scripts that enumerate environment variables, print/hash/encode credentials, access arbitrary hosts, use broad filesystem access, persist data, run subprocesses, or perform unrelated activity.
- deny or ask for admin approval when the requester is non-admin and the script reads or prints other users' private data, including user lists, sessions, watch history, request history, issue history, quotas, emails, usernames, Discord IDs, Jellyfin IDs, Seerr IDs, or preferences.
- for non-admin requesters, allow only narrow lookups for the requester's own mapped Seerr user id or for the specific media/server item being discussed; do not allow broad user, session, issue, request, or history enumeration.
- require scripts to print minimized summaries only. Do not allow raw API responses, raw logs, internal service URLs, filesystem paths, queue/download/request ids, credentials, headers, or unrelated fields in output.
- grant only permissions needed by this exact script.
- allowed service network hosts: %v
- allowed environment variables: %v
- allowed read-only filesystem roots: %v
- do not grant read/write permissions unless the script clearly needs them for a harmless diagnostic.

Request source: %s
Request author: %s
Requester id: %s
Requester admin: %t
Audience: %s
Mapped Seerr user id: %s
Purpose: %s

Script:
%s`, servicePermissions.AllowNet, servicePermissions.AllowEnv, servicePermissions.AllowRead, req.Source, req.Author, nonEmptyMetadata(req.AuthorID), req.IsAdmin, requestAudience(req), nonEmptyMetadata(req.SeerrUserID), purpose, script)
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
