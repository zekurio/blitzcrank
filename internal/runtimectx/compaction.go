package runtimectx

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type CompactionEntry struct {
	Type             string         `json:"type"`
	ID               string         `json:"id"`
	ParentID         string         `json:"parentId,omitempty"`
	Timestamp        string         `json:"timestamp"`
	Summary          string         `json:"summary"`
	FirstKeptEntryID string         `json:"firstKeptEntryId"`
	TokensBefore     int            `json:"tokensBefore"`
	Details          map[string]any `json:"details,omitempty"`
}

type NewCompactionEntryOptions struct {
	ParentID         string
	Summary          string
	FirstKeptEntryID string
	TokensBefore     int
	Details          map[string]any
	Now              time.Time
}

func NewCompactionEntry(opts NewCompactionEntryOptions) CompactionEntry {
	now := opts.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	timestamp := now.UTC().Format(time.RFC3339)
	return CompactionEntry{
		Type:             "compaction",
		ID:               compactionEntryID(opts.ParentID, timestamp, opts.Summary, opts.FirstKeptEntryID),
		ParentID:         strings.TrimSpace(opts.ParentID),
		Timestamp:        timestamp,
		Summary:          strings.TrimSpace(opts.Summary),
		FirstKeptEntryID: strings.TrimSpace(opts.FirstKeptEntryID),
		TokensBefore:     opts.TokensBefore,
		Details:          cloneDetails(opts.Details),
	}
}

func AppendCompactionEntries(path string, entries []CompactionEntry) error {
	path = strings.TrimSpace(path)
	if path == "" || len(entries) == 0 {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create compaction ledger directory %s: %w", filepath.Dir(path), err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open compaction ledger %s: %w", path, err)
	}
	defer file.Close()
	for _, entry := range entries {
		if entry.Type == "" {
			entry.Type = "compaction"
		}
		data, err := json.Marshal(entry)
		if err != nil {
			return fmt.Errorf("marshal compaction entry for %s: %w", path, err)
		}
		if _, err := fmt.Fprintln(file, string(data)); err != nil {
			return fmt.Errorf("append compaction ledger %s: %w", path, err)
		}
	}
	return nil
}

func ReadCompactionEntries(path string, limit int) ([]CompactionEntry, error) {
	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("open compaction ledger %s: %w", path, err)
	}
	defer file.Close()

	var entries []CompactionEntry
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var entry CompactionEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			return nil, fmt.Errorf("parse compaction ledger %s: %w", path, err)
		}
		if entry.Type == "compaction" {
			entries = append(entries, entry)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read compaction ledger %s: %w", path, err)
	}
	if limit > 0 && len(entries) > limit {
		entries = entries[len(entries)-limit:]
	}
	return entries, nil
}

func compactionEntryID(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(sum[:4])
}

func cloneDetails(details map[string]any) map[string]any {
	if len(details) == 0 {
		return nil
	}
	out := make(map[string]any, len(details))
	for key, value := range details {
		out[key] = value
	}
	return out
}
