package tools

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

func formatMemoryMarkdown(record memoryRecord) string {
	lines := []string{
		"---",
		"scope: " + record.Scope,
		"key: " + record.Key,
		"title: " + quoteFrontmatter(record.Title),
		"created_at: " + record.CreatedAt.Format(time.RFC3339),
		"updated_at: " + record.UpdatedAt.Format(time.RFC3339),
	}
	if len(record.Tags) > 0 {
		lines = append(lines, "tags: ["+strings.Join(record.Tags, ", ")+"]")
	}
	if len(record.Metadata) > 0 {
		data, _ := json.Marshal(record.Metadata)
		lines = append(lines, "metadata: "+string(data))
	}
	lines = append(lines, "---", "", strings.TrimSpace(record.Content), "")
	return strings.Join(lines, "\n")
}

func readMemoryFile(path string) (memoryRecord, error) {
	var record memoryRecord
	data, err := os.ReadFile(path)
	if err != nil {
		return record, err
	}
	frontmatter, body, err := splitMemoryMarkdown(string(data))
	if err != nil {
		return record, err
	}
	record.Path = path
	record.Content = strings.TrimSpace(body)
	record.Scope = frontmatter["scope"]
	record.Key = frontmatter["key"]
	record.Title = unquoteFrontmatter(frontmatter["title"])
	record.Tags = parseTags(frontmatter["tags"])
	if value := frontmatter["metadata"]; value != "" {
		if err := json.Unmarshal([]byte(value), &record.Metadata); err != nil {
			return record, fmt.Errorf("parse memory metadata in %s: %w", path, err)
		}
	}
	if value := frontmatter["created_at"]; value != "" {
		record.CreatedAt, err = time.Parse(time.RFC3339, value)
		if err != nil {
			return record, fmt.Errorf("parse memory created_at in %s: %w", path, err)
		}
	}
	if value := frontmatter["updated_at"]; value != "" {
		record.UpdatedAt, err = time.Parse(time.RFC3339, value)
		if err != nil {
			return record, fmt.Errorf("parse memory updated_at in %s: %w", path, err)
		}
	}
	return record, nil
}

func splitMemoryMarkdown(value string) (map[string]string, string, error) {
	scanner := bufio.NewScanner(strings.NewReader(value))
	if !scanner.Scan() || strings.TrimSpace(scanner.Text()) != "---" {
		return nil, "", errors.New("memory markdown is missing frontmatter")
	}
	frontmatter := map[string]string{}
	var body []string
	inFrontmatter := true
	for scanner.Scan() {
		line := scanner.Text()
		if inFrontmatter {
			if strings.TrimSpace(line) == "---" {
				inFrontmatter = false
				continue
			}
			key, value, ok := strings.Cut(line, ":")
			if ok {
				frontmatter[strings.TrimSpace(key)] = strings.TrimSpace(value)
			}
			continue
		}
		body = append(body, line)
	}
	if err := scanner.Err(); err != nil {
		return nil, "", err
	}
	if inFrontmatter {
		return nil, "", errors.New("memory markdown has unterminated frontmatter")
	}
	return frontmatter, strings.Join(body, "\n"), nil
}

func quoteFrontmatter(value string) string {
	data, _ := json.Marshal(value)
	return string(data)
}

func unquoteFrontmatter(value string) string {
	var out string
	if err := json.Unmarshal([]byte(value), &out); err == nil {
		return out
	}
	return strings.Trim(value, `"`)
}

func parseTags(value string) []string {
	value = strings.TrimSpace(value)
	value = strings.TrimPrefix(value, "[")
	value = strings.TrimSuffix(value, "]")
	return splitCSV(value)
}

func splitCSV(value string) []string {
	var out []string
	seen := map[string]bool{}
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		key := strings.ToLower(part)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, part)
	}
	return out
}
