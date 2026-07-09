package discord

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

const maxTriageResponseBytes = 4096

type triageDecision struct {
	Relevant   bool
	Respond    bool
	Route      string
	Category   string
	Language   string
	ThreadName string
	Reason     string
}

type triageWire struct {
	Relevant   *bool   `json:"relevant"`
	Respond    *bool   `json:"respond"`
	Route      *string `json:"route"`
	Category   *string `json:"category"`
	Language   *string `json:"language"`
	ThreadName *string `json:"thread_name"`
	Reason     *string `json:"reason"`
}

func parseTriageDecision(value string) (triageDecision, error) {
	if len(value) > maxTriageResponseBytes {
		return triageDecision{}, fmt.Errorf("triage response exceeds %d bytes", maxTriageResponseBytes)
	}
	decoder := json.NewDecoder(bytes.NewBufferString(value))
	decoder.DisallowUnknownFields()
	var wire triageWire
	if err := decoder.Decode(&wire); err != nil {
		return triageDecision{}, fmt.Errorf("decode triage response: %w", err)
	}
	if err := requireJSONEOF(decoder); err != nil {
		return triageDecision{}, err
	}
	if wire.Relevant == nil || wire.Respond == nil || wire.Route == nil || wire.Category == nil || wire.Language == nil || wire.Reason == nil {
		return triageDecision{}, fmt.Errorf("triage response is missing required fields")
	}

	decision := triageDecision{
		Relevant:   *wire.Relevant,
		Respond:    *wire.Respond,
		Route:      strings.ToLower(strings.TrimSpace(*wire.Route)),
		Category:   strings.ToLower(strings.TrimSpace(*wire.Category)),
		Language:   strings.ToLower(strings.TrimSpace(*wire.Language)),
		ThreadName: strings.TrimSpace(valueOrEmpty(wire.ThreadName)),
		Reason:     strings.TrimSpace(*wire.Reason),
	}
	if !oneOf(decision.Route, "direct", "private", "ignore") {
		return triageDecision{}, fmt.Errorf("invalid triage route %q", decision.Route)
	}
	if !oneOf(decision.Category, "release", "general", "service", "request", "playback", "support", "unsupported") {
		return triageDecision{}, fmt.Errorf("invalid triage category %q", decision.Category)
	}
	if decision.Language == "" || len(decision.Language) > 35 {
		return triageDecision{}, fmt.Errorf("invalid triage language")
	}
	if len([]rune(decision.ThreadName)) > 60 {
		return triageDecision{}, fmt.Errorf("invalid triage thread name")
	}
	if decision.Reason == "" || len([]rune(decision.Reason)) > 300 {
		return triageDecision{}, fmt.Errorf("invalid triage reason")
	}
	if decision.Route != "ignore" && (!decision.Relevant || !decision.Respond) {
		return triageDecision{}, fmt.Errorf("active route requires relevance and response intent")
	}
	if decision.Route == "direct" && decision.Category != "release" && decision.Category != "general" {
		decision.Route = "private"
	}
	if decision.Category == "unsupported" {
		decision.Route = "ignore"
	}
	return decision, nil
}

func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func requireJSONEOF(decoder *json.Decoder) error {
	var extra any
	err := decoder.Decode(&extra)
	if err == io.EOF {
		return nil
	}
	if err != nil {
		return fmt.Errorf("decode trailing triage response: %w", err)
	}
	return fmt.Errorf("triage response contains trailing JSON")
}

func oneOf(value string, values ...string) bool {
	for _, candidate := range values {
		if value == candidate {
			return true
		}
	}
	return false
}

func (d triageDecision) activates() bool {
	return d.Relevant && d.Respond && d.Route != "ignore"
}
