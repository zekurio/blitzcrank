package automation

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"blitzcrank/internal/config"
)

const (
	DefaultMutationBudget = 5
	MaxMutationBudget     = 10
)

type Task struct {
	Name           string
	Description    string
	Schedule       string
	Capabilities   []string
	MutationPolicy string
	MutationBudget int
	Path           string
	Body           string
}

func LoadTasks(cfg config.Config) ([]Task, error) {
	dirs := []string{cfg.AutomationsDirectory}
	dirs = append(dirs, cfg.AutomationsExtraDirs...)
	var tasks []Task
	for _, dir := range dirs {
		dir = strings.TrimSpace(dir)
		if dir == "" {
			continue
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, fmt.Errorf("read automations dir %s: %w", dir, err)
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
				continue
			}
			path := filepath.Join(dir, entry.Name())
			task, err := parseTaskFile(path)
			if err != nil {
				return nil, err
			}
			tasks = append(tasks, task)
		}
	}
	return tasks, nil
}

func parseTaskFile(path string) (Task, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Task{}, fmt.Errorf("read automation %s: %w", path, err)
	}
	text := strings.TrimSpace(string(data))
	task := Task{
		Path:           path,
		Name:           strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)),
		MutationBudget: DefaultMutationBudget,
	}
	if strings.HasPrefix(text, "---\n") {
		rest := strings.TrimPrefix(text, "---\n")
		front, body, ok := strings.Cut(rest, "\n---")
		if ok {
			lines := strings.Split(front, "\n")
			for i := 0; i < len(lines); i++ {
				line := lines[i]
				key, value, ok := strings.Cut(line, ":")
				if !ok {
					continue
				}
				key = strings.TrimSpace(key)
				value = strings.Trim(strings.TrimSpace(value), `"'`)
				switch key {
				case "name":
					task.Name = value
				case "description":
					task.Description = value
				case "schedule":
					task.Schedule = value
				case "capabilities":
					capabilities, consumed, err := parseCapabilities(value, lines[i+1:])
					if err != nil {
						return Task{}, fmt.Errorf("parse automation %s capabilities: %w", path, err)
					}
					task.Capabilities = capabilities
					i += consumed
				case "mutation_policy":
					policy := strings.ToLower(strings.TrimSpace(value))
					if policy != "" && policy != "read_only" && policy != "narrow" {
						return Task{}, fmt.Errorf("parse automation %s mutation_policy: must be read_only or narrow", path)
					}
					task.MutationPolicy = policy
				case "mutation_budget":
					budget, err := strconv.Atoi(value)
					if err != nil || budget < 0 || budget > MaxMutationBudget {
						return Task{}, fmt.Errorf("parse automation %s mutation_budget: must be between 0 and %d", path, MaxMutationBudget)
					}
					task.MutationBudget = budget
				}
			}
			task.Body = strings.TrimSpace(strings.TrimPrefix(body, "\n"))
			return task, nil
		}
	}
	task.Body = text
	return task, nil
}

func parseCapabilities(inline string, following []string) ([]string, int, error) {
	var raw []string
	consumed := 0
	inline = strings.TrimSpace(inline)
	if inline != "" {
		inline = strings.TrimPrefix(inline, "[")
		inline = strings.TrimSuffix(inline, "]")
		raw = strings.Split(inline, ",")
	} else {
		for _, line := range following {
			trimmed := strings.TrimSpace(line)
			if !strings.HasPrefix(trimmed, "-") {
				break
			}
			consumed++
			raw = append(raw, strings.TrimSpace(strings.TrimPrefix(trimmed, "-")))
		}
	}

	seen := make(map[string]struct{}, len(raw))
	capabilities := make([]string, 0, len(raw))
	for _, capability := range raw {
		capability = strings.ToLower(strings.Trim(strings.TrimSpace(capability), `"'`))
		if capability == "" {
			continue
		}
		if !validCapability(capability) {
			return nil, 0, fmt.Errorf("invalid capability %q", capability)
		}
		if _, ok := seen[capability]; ok {
			continue
		}
		seen[capability] = struct{}{}
		capabilities = append(capabilities, capability)
	}
	return capabilities, consumed, nil
}

func validCapability(value string) bool {
	if !strings.Contains(value, ".") {
		return false
	}
	for _, char := range value {
		switch {
		case char >= 'a' && char <= 'z':
		case char >= '0' && char <= '9':
		case char == '.', char == '_', char == '-':
		default:
			return false
		}
	}
	return true
}
