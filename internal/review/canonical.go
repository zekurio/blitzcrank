package review

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

const (
	maxProposalBodyBytes = 128 * 1024
	maxEvidenceItems     = 8
	maxEvidenceBytes     = 32 * 1024
	maxClaimBytes        = 4 * 1024
)

var (
	sensitiveText = regexp.MustCompile(`(?i)(authorization\s*[:=]\s*(?:bearer\s+)?|api[_-]?key\s*[:=]\s*|token\s*[:=]\s*|password\s*[:=]\s*)[^\s,;&]+`)
	sensitivePath = regexp.MustCompile(`(?i)(api[_-]?key|apikey|authorization|password|token)`)
)

func NormalizeProposal(proposal Proposal) (SanitizedProposal, error) {
	return normalizeProposal(proposal)
}

func normalizeProposal(proposal Proposal) (SanitizedProposal, error) {
	service := strings.ToLower(strings.TrimSpace(proposal.Service))
	method := strings.ToUpper(strings.TrimSpace(proposal.Method))
	path := proposal.Path
	if service == "" || method == "" || path == "" {
		return SanitizedProposal{}, fmt.Errorf("service, method, and path are required")
	}
	if path != strings.TrimSpace(path) || !strings.HasPrefix(path, "/") || strings.ContainsAny(path, "\r\n#") {
		return SanitizedProposal{}, fmt.Errorf("%w: path must be an exact service-relative path", ErrForbidden)
	}
	if strings.HasPrefix(strings.ToLower(path), "//") || sensitivePath.MatchString(path) {
		return SanitizedProposal{}, fmt.Errorf("%w: path contains a URL authority or credential field", ErrForbidden)
	}
	parsed, err := url.ParseRequestURI(path)
	if err != nil || parsed.IsAbs() || parsed.Host != "" {
		return SanitizedProposal{}, fmt.Errorf("%w: invalid service-relative path", ErrForbidden)
	}
	switch method {
	case "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE":
	default:
		return SanitizedProposal{}, fmt.Errorf("%w: unsupported HTTP method %q", ErrForbidden, method)
	}
	purpose := sanitizeText(strings.TrimSpace(proposal.Purpose), maxClaimBytes)
	safetyClaim := sanitizeText(strings.TrimSpace(proposal.SafetyClaim), maxClaimBytes)
	if method != "GET" && method != "HEAD" {
		if purpose == "" {
			return SanitizedProposal{}, fmt.Errorf("purpose is required for mutations")
		}
		if safetyClaim == "" {
			return SanitizedProposal{}, fmt.Errorf("working-agent safety claim is required for mutations")
		}
	}
	body, err := canonicalBody(proposal.Body)
	if err != nil {
		return SanitizedProposal{}, err
	}
	evidence := normalizeEvidence(proposal.Evidence)
	return SanitizedProposal{
		Service:     service,
		Method:      method,
		Path:        path,
		Body:        body,
		Purpose:     purpose,
		SafetyClaim: safetyClaim,
		Evidence:    evidence,
	}, nil
}

func canonicalBody(body any) (json.RawMessage, error) {
	if body == nil {
		return json.RawMessage("null"), nil
	}
	var encoded []byte
	var err error
	switch value := body.(type) {
	case json.RawMessage:
		encoded = append([]byte(nil), value...)
	case []byte:
		encoded = append([]byte(nil), value...)
	default:
		encoded, err = json.Marshal(value)
		if err != nil {
			return nil, fmt.Errorf("encode mutation body: %w", err)
		}
	}
	if len(encoded) == 0 {
		encoded = []byte("null")
	}
	if len(encoded) > maxProposalBodyBytes {
		return nil, fmt.Errorf("mutation body exceeds %d bytes", maxProposalBodyBytes)
	}
	decoded, err := decodeOneJSON(encoded)
	if err != nil {
		return nil, fmt.Errorf("decode mutation body: %w", err)
	}
	if key := firstSensitiveKey(decoded); key != "" {
		return nil, fmt.Errorf("%w: mutation body must not contain credential field %q", ErrForbidden, key)
	}
	canonical, err := json.Marshal(decoded)
	if err != nil {
		return nil, fmt.Errorf("canonicalize mutation body: %w", err)
	}
	if len(canonical) > maxProposalBodyBytes {
		return nil, fmt.Errorf("canonical mutation body exceeds %d bytes", maxProposalBodyBytes)
	}
	return canonical, nil
}

func firstSensitiveKey(value any) string {
	switch value := value.(type) {
	case map[string]any:
		for key, child := range value {
			normalized := strings.NewReplacer("_", "", "-", "", ".", "").Replace(strings.ToLower(key))
			switch normalized {
			case "apikey", "token", "accesstoken", "refreshtoken", "authorization", "password", "secret", "cookie", "setcookie":
				return key
			}
			if found := firstSensitiveKey(child); found != "" {
				return found
			}
		}
	case []any:
		for _, child := range value {
			if found := firstSensitiveKey(child); found != "" {
				return found
			}
		}
	}
	return ""
}

func normalizeEvidence(evidence []Evidence) []Evidence {
	if len(evidence) > maxEvidenceItems {
		evidence = evidence[len(evidence)-maxEvidenceItems:]
	}
	out := make([]Evidence, 0, len(evidence))
	remaining := maxEvidenceBytes
	for _, item := range evidence {
		if remaining <= 0 {
			break
		}
		item.Service = strings.ToLower(strings.TrimSpace(item.Service))
		item.Method = strings.ToUpper(strings.TrimSpace(item.Method))
		item.Path = sanitizeText(strings.TrimSpace(item.Path), min(2*1024, remaining))
		item.Summary = sanitizeText(strings.TrimSpace(item.Summary), min(8*1024, remaining))
		if item.Summary == "" {
			continue
		}
		remaining -= len(item.Service) + len(item.Method) + len(item.Path) + len(item.Summary)
		out = append(out, item)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func sanitizeText(value string, limit int) string {
	value = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' || r >= ' ' {
			return r
		}
		return -1
	}, value)
	value = sensitiveText.ReplaceAllString(value, "${1}[REDACTED]")
	if limit > 0 && len(value) > limit {
		value = value[:limit]
	}
	return value
}

func BindingHash(run RunContext, proposal Proposal) (string, error) {
	run, err := normalizeRunContext(run)
	if err != nil {
		return "", err
	}
	normalized, err := normalizeProposal(proposal)
	if err != nil {
		return "", err
	}
	return bindingHash(run, normalized), nil
}

func bindingHash(run RunContext, proposal SanitizedProposal) string {
	envelope := struct {
		Version        int             `json:"version"`
		Service        string          `json:"service"`
		Method         string          `json:"method"`
		Path           string          `json:"path"`
		Body           json.RawMessage `json:"body"`
		RunID          string          `json:"run_id"`
		Source         string          `json:"source"`
		ActorID        string          `json:"actor_id"`
		ConversationID string          `json:"conversation_id"`
	}{
		Version:        1,
		Service:        proposal.Service,
		Method:         proposal.Method,
		Path:           proposal.Path,
		Body:           proposal.Body,
		RunID:          run.RunID,
		Source:         run.Source,
		ActorID:        run.ActorID,
		ConversationID: run.ConversationID,
	}
	encoded, _ := json.Marshal(envelope)
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

func actionKey(classification Classification, proposal SanitizedProposal) string {
	envelope := struct {
		Version    int             `json:"version"`
		Service    string          `json:"service"`
		Capability string          `json:"capability"`
		Path       string          `json:"path"`
		Body       json.RawMessage `json:"body"`
	}{
		Version:    1,
		Service:    proposal.Service,
		Capability: classification.Capability,
		Path:       canonicalActionPath(proposal.Path),
		Body:       proposal.Body,
	}
	encoded, _ := json.Marshal(envelope)
	digest := sha256.Sum256(encoded)
	return classification.Capability + ":" + hex.EncodeToString(digest[:])
}

func canonicalActionPath(path string) string {
	parsed, err := url.ParseRequestURI(path)
	if err != nil {
		return path
	}
	parsed.RawQuery = parsed.Query().Encode()
	return parsed.RequestURI()
}

func equalCanonicalBody(left, right json.RawMessage) bool {
	return bytes.Equal(left, right)
}
