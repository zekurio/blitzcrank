package automation

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"blitzcrank/internal/config"
)

type Task struct {
	Name        string
	Description string
	Schedule    string
	Path        string
	Body        string
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
	task := Task{Path: path, Name: strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))}
	if strings.HasPrefix(text, "---\n") {
		rest := strings.TrimPrefix(text, "---\n")
		front, body, ok := strings.Cut(rest, "\n---")
		if ok {
			for _, line := range strings.Split(front, "\n") {
				key, value, ok := strings.Cut(line, ":")
				if !ok {
					continue
				}
				value = strings.Trim(strings.TrimSpace(value), `"'`)
				switch strings.TrimSpace(key) {
				case "name":
					task.Name = value
				case "description":
					task.Description = value
				case "schedule":
					task.Schedule = value
				}
			}
			task.Body = strings.TrimSpace(strings.TrimPrefix(body, "\n"))
			return task, nil
		}
	}
	task.Body = text
	return task, nil
}
