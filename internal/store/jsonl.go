package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

func AppendJSONL(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create JSONL directory %s: %w", filepath.Dir(path), err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open JSONL file %s: %w", path, err)
	}
	defer file.Close()
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("marshal JSONL value for %s: %w", path, err)
	}
	if _, err := fmt.Fprintln(file, string(data)); err != nil {
		return fmt.Errorf("append JSONL file %s: %w", path, err)
	}
	return nil
}
