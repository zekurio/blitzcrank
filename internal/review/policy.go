package review

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"slices"
	"strings"
)

var (
	ErrForbidden         = errors.New("mutation is forbidden by deterministic policy")
	ErrNotMutation       = errors.New("request is not an operational mutation")
	ErrUnauthorized      = errors.New("review authorization is invalid")
	ErrBudgetExceeded    = errors.New("mutation review budget is exhausted")
	ErrReviewDenied      = errors.New("mutation review denied")
	ErrNeedsConfirmation = errors.New("mutation needs confirmation")
	ErrApprovalBinding   = errors.New("mutation approval does not match proposal")

	arrCommandPath      = regexp.MustCompile(`(?i)^/api/v3/command/?$`)
	arrQueueGrabPath    = regexp.MustCompile(`(?i)^/api/v3/queue/grab/[0-9]+/?$`)
	arrQueuePath        = regexp.MustCompile(`(?i)^/api/v3/queue/[0-9]+/?$`)
	arrBlocklistPath    = regexp.MustCompile(`(?i)^/api/v3/blocklist/[0-9]+/?$`)
	jellyfinRefreshPath = regexp.MustCompile(`(?i)^/Items/[^/]+/Refresh/?$`)
	seerrRequestPath    = regexp.MustCompile(`(?i)^/api/v1/request/?$`)
	seerrResolvePath    = regexp.MustCompile(`(?i)^/api/v1/issue/[^/]+/resolved/?$`)
)

func Classify(proposal Proposal) (Classification, error) {
	normalized, err := normalizeProposal(proposal)
	if err != nil {
		return Classification{}, err
	}
	return classifySanitized(normalized)
}

func classifySanitized(proposal SanitizedProposal) (Classification, error) {
	if proposal.Method == "GET" || proposal.Method == "HEAD" {
		return Classification{}, ErrNotMutation
	}
	parsed, err := url.ParseRequestURI(proposal.Path)
	if err != nil || parsed.Path == "" {
		return Classification{}, fmt.Errorf("%w: invalid service-relative path", ErrForbidden)
	}

	switch proposal.Service {
	case "sonarr", "radarr":
		return classifyArr(proposal, parsed)
	case "jellyfin":
		if proposal.Method != "POST" || !jellyfinRefreshPath.MatchString(parsed.Path) {
			return Classification{}, forbiddenMethodPath(proposal)
		}
		if err := validateQuery(parsed.Query(), []string{"recursive", "imagerefreshmode", "metadatarefreshmode", "replaceallimages"}); err != nil {
			return Classification{}, err
		}
		return Classification{
			Risk:       RiskLow,
			Capability: "jellyfin.metadata_refresh",
			Category:   "metadata_refresh",
		}, nil
	case "seerr":
		switch {
		case proposal.Method == "POST" && seerrRequestPath.MatchString(parsed.Path):
			if parsed.RawQuery != "" {
				return Classification{}, fmt.Errorf("%w: Seerr request mutation does not accept query parameters", ErrForbidden)
			}
			return Classification{
				Risk:       RiskMedium,
				Capability: "seerr.media_request",
				Category:   "media_request",
			}, nil
		case proposal.Method == "POST" && seerrResolvePath.MatchString(parsed.Path):
			if parsed.RawQuery != "" {
				return Classification{}, fmt.Errorf("%w: Seerr issue resolution does not accept query parameters", ErrForbidden)
			}
			return Classification{
				Risk:       RiskMedium,
				Capability: "seerr.issue_resolve",
				Category:   "issue_resolution",
			}, nil
		default:
			return Classification{}, forbiddenMethodPath(proposal)
		}
	default:
		return Classification{}, fmt.Errorf("%w: unknown or read-only service %q", ErrForbidden, proposal.Service)
	}
}

func classifyArr(proposal SanitizedProposal, parsed *url.URL) (Classification, error) {
	service := proposal.Service
	if proposal.Method == "POST" && arrCommandPath.MatchString(parsed.Path) {
		if parsed.RawQuery != "" {
			return Classification{}, fmt.Errorf("%w: Arr command mutation does not accept query parameters", ErrForbidden)
		}
		name, err := commandName(proposal.Body)
		if err != nil {
			return Classification{}, err
		}
		switch strings.ToLower(name) {
		case "refreshseries":
			if service != "sonarr" {
				return Classification{}, forbiddenCommand(service, name)
			}
			return arrClassification(service, "metadata_refresh", RiskLow, "metadata_refresh"), nil
		case "refreshmovie":
			if service != "radarr" {
				return Classification{}, forbiddenCommand(service, name)
			}
			return arrClassification(service, "metadata_refresh", RiskLow, "metadata_refresh"), nil
		case "episodesearch", "seasonsearch", "seriessearch":
			if service != "sonarr" {
				return Classification{}, forbiddenCommand(service, name)
			}
			return arrClassification(service, "search", RiskMedium, "search_or_grab"), nil
		case "moviessearch":
			if service != "radarr" {
				return Classification{}, forbiddenCommand(service, name)
			}
			return arrClassification(service, "search", RiskMedium, "search_or_grab"), nil
		case "manualimport":
			return arrClassification(service, "manual_import", RiskMedium, "manual_import"), nil
		default:
			return Classification{}, forbiddenCommand(service, name)
		}
	}
	if proposal.Method == "POST" && arrQueueGrabPath.MatchString(parsed.Path) {
		if parsed.RawQuery != "" {
			return Classification{}, fmt.Errorf("%w: queue grab does not accept query parameters", ErrForbidden)
		}
		return arrClassification(service, "queue_grab", RiskMedium, "search_or_grab"), nil
	}
	if proposal.Method == "DELETE" && arrQueuePath.MatchString(parsed.Path) {
		if err := validateBooleanQuery(parsed.Query(), []string{"removefromclient", "blocklist"}); err != nil {
			return Classification{}, err
		}
		capability := "queue_cleanup"
		query := lowerQuery(parsed.Query())
		if query.Get("removefromclient") == "true" && query.Get("blocklist") == "true" && len(query) == 2 {
			capability = "queue_rejection_cleanup"
		}
		return arrClassification(service, capability, RiskHigh, "queue_cleanup"), nil
	}
	if proposal.Method == "DELETE" && arrBlocklistPath.MatchString(parsed.Path) {
		if parsed.RawQuery != "" {
			return Classification{}, fmt.Errorf("%w: blocklist deletion does not accept query parameters", ErrForbidden)
		}
		return arrClassification(service, "blocklist_delete", RiskHigh, "blocklist_change"), nil
	}
	return Classification{}, forbiddenMethodPath(proposal)
}

func arrClassification(service, action string, risk Risk, category string) Classification {
	return Classification{Risk: risk, Capability: service + "." + action, Category: category}
}

func commandName(body json.RawMessage) (string, error) {
	var command map[string]any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&command); err != nil {
		return "", fmt.Errorf("%w: decode command body: %v", ErrForbidden, err)
	}
	name, _ := command["name"].(string)
	name = strings.TrimSpace(name)
	if name == "" {
		return "", fmt.Errorf("%w: Arr command name is required", ErrForbidden)
	}
	return name, nil
}

func forbiddenCommand(service, name string) error {
	return fmt.Errorf("%w: %s command %q is not allowlisted", ErrForbidden, service, name)
}

func forbiddenMethodPath(proposal SanitizedProposal) error {
	return fmt.Errorf("%w: %s %s is not allowlisted for %s", ErrForbidden, proposal.Method, proposal.Path, proposal.Service)
}

func validateQuery(query url.Values, allowed []string) error {
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, key := range allowed {
		allowedSet[key] = struct{}{}
	}
	for key, values := range query {
		if _, ok := allowedSet[strings.ToLower(key)]; !ok {
			return fmt.Errorf("%w: query parameter %q is not allowlisted", ErrForbidden, key)
		}
		if len(values) != 1 {
			return fmt.Errorf("%w: query parameter %q must occur once", ErrForbidden, key)
		}
	}
	return nil
}

func validateBooleanQuery(query url.Values, allowed []string) error {
	if err := validateQuery(query, allowed); err != nil {
		return err
	}
	for key, values := range query {
		value := strings.ToLower(values[0])
		if value != "true" && value != "false" {
			return fmt.Errorf("%w: query parameter %q must be boolean", ErrForbidden, key)
		}
	}
	return nil
}

func lowerQuery(query url.Values) url.Values {
	out := make(url.Values, len(query))
	for key, values := range query {
		out[strings.ToLower(key)] = append([]string(nil), values...)
		for index := range out[strings.ToLower(key)] {
			out[strings.ToLower(key)][index] = strings.ToLower(out[strings.ToLower(key)][index])
		}
	}
	return out
}

func mutationAllowedForRun(run RunContext, classification Classification) error {
	policy := strings.ToLower(strings.TrimSpace(run.MutationPolicy))
	if slices.Contains([]string{"none", "deny", "read_only", "readonly"}, policy) {
		return fmt.Errorf("%w: run mutation policy is %q", ErrForbidden, run.MutationPolicy)
	}
	if strings.HasPrefix(strings.ToLower(run.Source), "automation") && policy != "narrow" {
		return fmt.Errorf("%w: automation must declare mutation_policy=narrow", ErrForbidden)
	}
	if strings.HasPrefix(strings.ToLower(run.Source), "automation") && len(run.Capabilities) == 0 {
		return fmt.Errorf("%w: automation has no declared mutation capabilities", ErrForbidden)
	}
	if len(run.Capabilities) == 0 {
		return nil
	}
	for _, capability := range run.Capabilities {
		if strings.EqualFold(strings.TrimSpace(capability), classification.Capability) {
			return nil
		}
	}
	return fmt.Errorf("%w: capability %q is not authorized for this run", ErrForbidden, classification.Capability)
}

func DefaultBudget(source string) int {
	source = strings.ToLower(strings.TrimSpace(source))
	switch {
	case strings.HasPrefix(source, "discord"):
		return 3
	case strings.HasPrefix(source, "seerr"):
		return 5
	case strings.HasPrefix(source, "automation"):
		return 5
	default:
		return 5
	}
}

func maximumBudget(source string) int {
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(source)), "automation") {
		return 10
	}
	return DefaultBudget(source)
}

func normalizeRunContext(run RunContext) (RunContext, error) {
	run.RunID = strings.TrimSpace(run.RunID)
	run.Source = strings.ToLower(strings.TrimSpace(run.Source))
	run.ActorID = strings.TrimSpace(run.ActorID)
	run.ConversationID = strings.TrimSpace(run.ConversationID)
	run.Authority = strings.TrimSpace(run.Authority)
	run.MutationPolicy = strings.ToLower(strings.TrimSpace(run.MutationPolicy))
	if run.RunID == "" || run.Source == "" || run.ActorID == "" || run.ConversationID == "" {
		return RunContext{}, fmt.Errorf("run_id, source, actor_id, and conversation_id are required")
	}
	if run.Budget < 0 || run.Budget > maximumBudget(run.Source) {
		return RunContext{}, fmt.Errorf("mutation budget %d is outside the allowed range 0..%d for %s", run.Budget, maximumBudget(run.Source), run.Source)
	}
	seen := make(map[string]struct{}, len(run.Capabilities))
	capabilities := make([]string, 0, len(run.Capabilities))
	for _, capability := range run.Capabilities {
		capability = strings.ToLower(strings.TrimSpace(capability))
		if capability == "" {
			continue
		}
		if _, ok := seen[capability]; ok {
			continue
		}
		seen[capability] = struct{}{}
		capabilities = append(capabilities, capability)
	}
	slices.Sort(capabilities)
	run.Capabilities = capabilities
	return run, nil
}

func decodeOneJSON(data []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("multiple JSON values")
		}
		return nil, err
	}
	return value, nil
}
