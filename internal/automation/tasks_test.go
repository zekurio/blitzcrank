package automation

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestHourlyStaleImportHandlerKeepsAnvilWaitsNonDestructive(t *testing.T) {
	t.Parallel()

	task, err := parseTaskFile(filepath.Join("..", "..", "automations", "hourly-stale-import-handler.md"))
	if err != nil {
		t.Fatalf("parseTaskFile() error = %v", err)
	}
	wantCapabilities := []string{
		"sonarr.manual_import",
		"radarr.manual_import",
		"sonarr.queue_rejection_cleanup",
		"radarr.queue_rejection_cleanup",
	}
	if !slices.Equal(task.Capabilities, wantCapabilities) {
		t.Fatalf("Capabilities = %#v, want %#v", task.Capabilities, wantCapabilities)
	}
	if task.MutationPolicy != "narrow" {
		t.Fatalf("MutationPolicy = %q, want narrow", task.MutationPolicy)
	}
	if task.MutationBudget != 5 {
		t.Fatalf("MutationBudget = %d, want 5", task.MutationBudget)
	}

	for _, want := range []string{
		"`anvil_status`",
		"`anvil_job_lookup`",
		"## Anvil wait rules",
		"never proves that a queue item is encoding",
		"match the Arr `downloadId` exactly to SABnzbd `nzo_id`",
		"Cross-source multiple matches or `truncated: true` are ambiguous",
		"Do not manual import, force import, remove, blocklist, search, retry, refresh",
		"Do not include Anvil wait items under `Manuell prüfen:`",
		"older than 24 hours",
	} {
		if !strings.Contains(task.Body, want) {
			t.Fatalf("automation body missing %q:\n%s", want, task.Body)
		}
	}
	for _, forbidden := range []string{"wait_recommended", "queued systemd job"} {
		if strings.Contains(task.Body, forbidden) {
			t.Fatalf("automation body still contains obsolete Anvil inference %q:\n%s", forbidden, task.Body)
		}
	}
}

func TestParseTaskMutationFrontMatter(t *testing.T) {
	tests := []struct {
		name             string
		frontMatter      string
		wantCapabilities []string
		wantPolicy       string
		wantBudget       int
		wantErr          string
	}{
		{
			name:             "inline capabilities are normalized and deduplicated",
			frontMatter:      `capabilities: ["Sonarr.Manual_Import", "radarr.manual-import", "sonarr.manual_import"]` + "\nmutation_policy: narrow\nmutation_budget: 3",
			wantCapabilities: []string{"sonarr.manual_import", "radarr.manual-import"},
			wantPolicy:       "narrow",
			wantBudget:       3,
		},
		{
			name:       "omitted fields get conservative default budget",
			wantBudget: DefaultMutationBudget,
		},
		{
			name:        "invalid policy is rejected",
			frontMatter: "mutation_policy: unrestricted",
			wantErr:     "mutation_policy",
		},
		{
			name:        "negative budget is rejected",
			frontMatter: "mutation_budget: -1",
			wantErr:     "mutation_budget",
		},
		{
			name:        "excessive budget is rejected",
			frontMatter: "mutation_budget: 11",
			wantErr:     "mutation_budget",
		},
		{
			name:        "malformed capability is rejected",
			frontMatter: "capabilities: [arbitrary]",
			wantErr:     "capabilities",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "task.md")
			contents := "---\nname: task\nschedule: \"@hourly\"\n" + tt.frontMatter + "\n---\n\nBody"
			if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
				t.Fatalf("write task: %v", err)
			}
			task, err := parseTaskFile(path)
			if tt.wantErr != "" {
				if err == nil {
					t.Fatalf("parseTaskFile() error = nil, want %q", tt.wantErr)
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("parseTaskFile() error = %q, want it to contain %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseTaskFile() error = %v", err)
			}
			if !slices.Equal(task.Capabilities, tt.wantCapabilities) {
				t.Fatalf("Capabilities = %#v, want %#v", task.Capabilities, tt.wantCapabilities)
			}
			if task.MutationPolicy != tt.wantPolicy {
				t.Fatalf("MutationPolicy = %q, want %q", task.MutationPolicy, tt.wantPolicy)
			}
			if task.MutationBudget != tt.wantBudget {
				t.Fatalf("MutationBudget = %d, want %d", task.MutationBudget, tt.wantBudget)
			}
		})
	}
}
