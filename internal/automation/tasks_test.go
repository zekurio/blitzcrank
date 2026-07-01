package automation

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestHourlyStaleImportHandlerKeepsAnvilWaitsNonDestructive(t *testing.T) {
	t.Parallel()

	task, err := parseTaskFile(filepath.Join("..", "..", "automations", "hourly-stale-import-handler.md"))
	if err != nil {
		t.Fatalf("parseTaskFile() error = %v", err)
	}

	for _, want := range []string{
		"`anvil_status`",
		"## Anvil wait rules",
		"Do not manual import, force import, remove, blocklist, search, retry, refresh",
		"Do not include Anvil wait items under `Manuell prüfen:`",
		"older than 24 hours",
	} {
		if !strings.Contains(task.Body, want) {
			t.Fatalf("automation body missing %q:\n%s", want, task.Body)
		}
	}
}
