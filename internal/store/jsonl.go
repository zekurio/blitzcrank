package store

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
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

func ReadJSONL(path string) ([]map[string]any, error) {
	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("open JSONL file %s: %w", path, err)
	}
	defer file.Close()

	var records []map[string]any
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			return nil, fmt.Errorf("parse JSONL file %s: %w", path, err)
		}
		records = append(records, record)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read JSONL file %s: %w", path, err)
	}
	return records, nil
}
