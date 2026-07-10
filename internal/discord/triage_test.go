package discord

import (
	"strings"
	"testing"
)

func TestParseTriageDecision(t *testing.T) {
	tests := []struct {
		name      string
		response  string
		wantRoute string
		wantError bool
	}{
		{
			name:      "valid direct release",
			response:  `{"relevant":true,"respond":true,"route":"direct","category":"release","language":"de","reason":"Aktuelle Frage."}`,
			wantRoute: "direct",
		},
		{
			name:      "simple service lookup can remain public",
			response:  `{"relevant":true,"respond":true,"route":"direct","category":"service","language":"de","reason":"Lokaler Status."}`,
			wantRoute: "direct",
		},
		{
			name:      "playback diagnosis cannot remain public",
			response:  `{"relevant":true,"respond":true,"route":"direct","category":"playback","language":"de","reason":"Wiedergabeproblem."}`,
			wantRoute: "private",
		},
		{
			name:      "valid ignore",
			response:  `{"relevant":false,"respond":false,"route":"ignore","category":"unsupported","language":"en","reason":"Not relevant."}`,
			wantRoute: "ignore",
		},
		{
			name:      "unsupported active classification fails closed",
			response:  `{"relevant":true,"respond":true,"route":"private","category":"unsupported","language":"de","reason":"Nicht unterstützt."}`,
			wantRoute: "ignore",
		},
		{
			name:      "markdown fence rejected",
			response:  "```json\n{\"relevant\":false}\n```",
			wantError: true,
		},
		{
			name:      "unknown field rejected",
			response:  `{"relevant":true,"respond":true,"route":"direct","category":"general","language":"de","reason":"ok","answer":"no"}`,
			wantError: true,
		},
		{
			name:      "missing field rejected",
			response:  `{"relevant":true,"respond":true,"route":"direct","category":"general","language":"de"}`,
			wantError: true,
		},
		{
			name:      "trailing value rejected",
			response:  `{"relevant":false,"respond":false,"route":"ignore","category":"unsupported","language":"de","reason":"x"} {}`,
			wantError: true,
		},
		{
			name:      "inconsistent active route rejected",
			response:  `{"relevant":false,"respond":true,"route":"private","category":"support","language":"de","reason":"x"}`,
			wantError: true,
		},
		{
			name:      "oversized response rejected",
			response:  strings.Repeat("x", maxTriageResponseBytes+1),
			wantError: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			decision, err := parseTriageDecision(tt.response)
			if tt.wantError {
				if err == nil {
					t.Fatalf("parseTriageDecision() error = nil, want error; decision=%+v", decision)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseTriageDecision() error = %v", err)
			}
			if decision.Route != tt.wantRoute {
				t.Errorf("route = %q, want %q", decision.Route, tt.wantRoute)
			}
		})
	}
}
