package tools

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type memoryRecord struct {
	Scope     string         `json:"scope"`
	Key       string         `json:"key"`
	Title     string         `json:"title,omitempty"`
	Content   string         `json:"content"`
	Tags      []string       `json:"tags,omitempty"`
	Metadata  map[string]any `json:"metadata,omitempty"`
	CreatedAt time.Time      `json:"created_at"`
	UpdatedAt time.Time      `json:"updated_at"`
	Path      string         `json:"path"`
}

type memorySummary struct {
	Scope     string    `json:"scope"`
	Key       string    `json:"key"`
	Title     string    `json:"title,omitempty"`
	Tags      []string  `json:"tags,omitempty"`
	UpdatedAt time.Time `json:"updated_at"`
	Path      string    `json:"path"`
}

func (r *Registry) callMemoryTool(_ context.Context, name string, args map[string]any) (any, bool, error) {
	switch name {
	case "memory_list":
		value, err := r.memoryList(args)
		return handled(value, err)
	case "memory_search":
		value, err := r.memorySearch(args)
		return handled(value, err)
	case "memory_get":
		value, err := r.memoryGet(stringArg(args, "scope"), stringArg(args, "key"))
		return handled(value, err)
	case "memory_upsert":
		value, err := r.memoryUpsert(args)
		return handled(value, err)
	case "memory_delete":
		value, err := r.memoryDelete(stringArg(args, "scope"), stringArg(args, "key"))
		return handled(value, err)
	default:
		return nil, false, nil
	}
}

func (r *Registry) memoryList(args map[string]any) (any, error) {
	limit, err := boundedLimit(args, "limit", 50, 100)
	if err != nil {
		return nil, err
	}
	scope := stringArg(args, "scope")
	keyPrefix := strings.Trim(strings.TrimSpace(stringArg(args, "key_prefix")), "/")
	tag := strings.ToLower(stringArg(args, "tag"))
	records, err := r.readMemories(scope)
	if err != nil {
		return nil, err
	}
	summaries := make([]memorySummary, 0, len(records))
	for _, record := range records {
		if keyPrefix != "" && record.Key != keyPrefix && !strings.HasPrefix(record.Key, keyPrefix+"/") {
			continue
		}
		if tag != "" && !hasTag(record.Tags, tag) {
			continue
		}
		summaries = append(summaries, memorySummary{
			Scope:     record.Scope,
			Key:       record.Key,
			Title:     record.Title,
			Tags:      record.Tags,
			UpdatedAt: record.UpdatedAt,
			Path:      record.Path,
		})
	}
	sortMemories(summaries)
	if len(summaries) > limit {
		summaries = summaries[:limit]
	}
	return map[string]any{"memories": summaries}, nil
}

func (r *Registry) memorySearch(args map[string]any) (any, error) {
	query := strings.ToLower(stringArg(args, "query"))
	if query == "" {
		return nil, errors.New("query is required")
	}
	limit, err := boundedLimit(args, "limit", 20, 100)
	if err != nil {
		return nil, err
	}
	records, err := r.readMemories(stringArg(args, "scope"))
	if err != nil {
		return nil, err
	}
	matches := make([]memoryRecord, 0)
	for _, record := range records {
		haystack, err := memorySearchText(record)
		if err != nil {
			return nil, err
		}
		if strings.Contains(strings.ToLower(haystack), query) {
			matches = append(matches, record)
		}
	}
	sort.Slice(matches, func(i, j int) bool {
		return matches[i].UpdatedAt.After(matches[j].UpdatedAt)
	})
	if len(matches) > limit {
		matches = matches[:limit]
	}
	return map[string]any{"memories": matches}, nil
}

func (r *Registry) memoryGet(scope, key string) (any, error) {
	path, err := r.memoryPath(scope, key)
	if err != nil {
		return nil, err
	}
	return readMemoryFile(path)
}

func (r *Registry) memoryUpsert(args map[string]any) (any, error) {
	scope := stringArg(args, "scope")
	key := stringArg(args, "key")
	path, err := r.memoryPath(scope, key)
	if err != nil {
		return nil, err
	}
	content := stringArg(args, "content")
	if content == "" {
		return nil, errors.New("content is required")
	}
	now := time.Now().UTC()
	record := memoryRecord{
		Scope:     strings.TrimSpace(scope),
		Key:       strings.Trim(strings.TrimSpace(key), "/"),
		Title:     stringArg(args, "title"),
		Content:   content,
		Tags:      splitCSV(stringArg(args, "tags")),
		CreatedAt: now,
		UpdatedAt: now,
		Path:      path,
	}
	if text := stringArg(args, "metadata"); text != "" {
		var metadata map[string]any
		if err := json.Unmarshal([]byte(text), &metadata); err != nil {
			return nil, fmt.Errorf("metadata must be a JSON object: %w", err)
		}
		record.Metadata = metadata
	}
	if existing, err := readMemoryFile(path); err == nil {
		record.CreatedAt = existing.CreatedAt
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, []byte(formatMemoryMarkdown(record)), 0o600); err != nil {
		return nil, err
	}
	return record, nil
}

func (r *Registry) memoryDelete(scope, key string) (any, error) {
	path, err := r.memoryPath(scope, key)
	if err != nil {
		return nil, err
	}
	if err := os.Remove(path); err != nil {
		return nil, err
	}
	pruneEmptyMemoryDirs(r.memoryRoot(), filepath.Dir(path))
	return map[string]any{"deleted": true, "scope": scope, "key": strings.Trim(key, "/")}, nil
}

func (r *Registry) readMemories(scope string) ([]memoryRecord, error) {
	root := r.memoryRoot()
	if strings.TrimSpace(scope) != "" {
		var err error
		root, err = r.memoryPath(scope, "")
		if err != nil {
			return nil, err
		}
	}
	var records []memoryRecord
	if _, err := os.Stat(root); errors.Is(err, os.ErrNotExist) {
		return records, nil
	}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || filepath.Ext(path) != ".md" {
			return nil
		}
		record, err := readMemoryFile(path)
		if err != nil {
			return err
		}
		records = append(records, record)
		return nil
	})
	return records, err
}

func (r *Registry) memoryPath(scope, key string) (string, error) {
	scope = strings.Trim(strings.TrimSpace(scope), "/")
	key = strings.Trim(strings.TrimSpace(key), "/")
	if scope == "" {
		return "", errors.New("scope is required")
	}
	if strings.Contains(scope, "/") {
		return "", errors.New("scope must be one top-level category")
	}
	if err := validateMemoryPath(scope); err != nil {
		return "", fmt.Errorf("invalid scope: %w", err)
	}
	if key != "" {
		if err := validateMemoryPath(key); err != nil {
			return "", fmt.Errorf("invalid key: %w", err)
		}
		return filepath.Join(append([]string{r.memoryRoot(), scope}, strings.Split(key, "/")...)...) + ".md", nil
	}
	return filepath.Join(r.memoryRoot(), scope), nil
}

func (r *Registry) memoryRoot() string {
	if strings.TrimSpace(r.cfg.MemoriesDirectory) == "" {
		return "memories"
	}
	return r.cfg.MemoriesDirectory
}

func validateMemoryPath(value string) error {
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return errors.New("path segments must be non-empty and must not be . or ..")
		}
		for _, ch := range part {
			if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '-' || ch == '_' || ch == '.' {
				continue
			}
			return fmt.Errorf("segment %q contains unsupported character %q", part, ch)
		}
	}
	return nil
}

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

func memorySearchText(record memoryRecord) (string, error) {
	metadata, err := json.Marshal(record.Metadata)
	if err != nil {
		return "", err
	}
	return strings.Join([]string{
		record.Scope,
		record.Key,
		record.Title,
		record.Content,
		strings.Join(record.Tags, " "),
		string(metadata),
	}, " "), nil
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

func hasTag(tags []string, tag string) bool {
	for _, value := range tags {
		if strings.EqualFold(strings.TrimSpace(value), tag) {
			return true
		}
	}
	return false
}

func boundedLimit(args map[string]any, key string, fallback, max int) (int, error) {
	limit, err := intArg(args, key)
	if err != nil {
		return 0, err
	}
	if limit <= 0 {
		limit = fallback
	}
	if limit > max {
		limit = max
	}
	return limit, nil
}

func sortMemories(values []memorySummary) {
	sort.Slice(values, func(i, j int) bool {
		if values[i].UpdatedAt.Equal(values[j].UpdatedAt) {
			return values[i].Scope+"/"+values[i].Key < values[j].Scope+"/"+values[j].Key
		}
		return values[i].UpdatedAt.After(values[j].UpdatedAt)
	})
}

func pruneEmptyMemoryDirs(root, dir string) {
	root, err := filepath.Abs(root)
	if err != nil {
		return
	}
	dir, err = filepath.Abs(dir)
	if err != nil {
		return
	}
	for strings.HasPrefix(dir, root) && dir != root {
		_ = os.Remove(dir)
		dir = filepath.Dir(dir)
	}
}
