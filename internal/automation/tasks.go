package automation

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/robfig/cron/v3"
)

func LoadTasks(root string) ([]Task, error) {
	tasks, err := loadTasksFromFS(os.DirFS(root), ".", root)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	return tasks, nil
}

func LoadTaskDirs(runtimeRoot string, extraRoots []string) ([]Task, error) {
	var all []Task
	if strings.TrimSpace(runtimeRoot) != "" {
		if !filepath.IsAbs(runtimeRoot) {
			runtimeRoot = localMarkdownDir(runtimeRoot)
		}
		tasks, err := LoadTasks(runtimeRoot)
		if err != nil {
			return nil, err
		}
		all = append(all, tasks...)
	}
	if len(all) == 0 {
		tasks, err := LoadTasks(localMarkdownDir("automations"))
		if err != nil {
			return nil, err
		}
		all = append(all, tasks...)
	}
	for _, extraRoot := range extraRoots {
		extraRoot = strings.TrimSpace(extraRoot)
		if extraRoot == "" {
			continue
		}
		tasks, err := LoadTasks(extraRoot)
		if err != nil {
			return nil, err
		}
		all = append(all, tasks...)
	}
	if err := rejectDuplicateTasks(all); err != nil {
		return nil, err
	}
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].Name == all[j].Name {
			return all[i].Path < all[j].Path
		}
		return all[i].Name < all[j].Name
	})
	return all, nil
}

func localMarkdownDir(name string) string {
	wd, err := os.Getwd()
	if err != nil {
		return name
	}
	for {
		candidate := filepath.Join(wd, name)
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
		next := filepath.Dir(wd)
		if next == wd {
			return name
		}
		wd = next
	}
}

func rejectDuplicateTasks(tasks []Task) error {
	seen := map[string]string{}
	for _, task := range tasks {
		name := strings.TrimSpace(task.Name)
		if previous, ok := seen[name]; ok {
			return fmt.Errorf("duplicate automation %q in %s and %s", name, previous, task.Path)
		}
		seen[name] = task.Path
	}
	return nil
}

func sameTaskSet(a, b []Task) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Name != b[i].Name ||
			a[i].Description != b[i].Description ||
			a[i].Schedule != b[i].Schedule ||
			a[i].Prompt != b[i].Prompt ||
			a[i].Path != b[i].Path {
			return false
		}
	}
	return true
}

func loadTasksFromFS(fsys fs.FS, root, displayRoot string) ([]Task, error) {
	entries, err := fs.ReadDir(fsys, root)
	if err != nil {
		return nil, err
	}

	var files []string
	for _, entry := range entries {
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), ".md") {
			continue
		}
		files = append(files, entry.Name())
	}
	sort.Strings(files)

	var tasks []Task
	for _, file := range files {
		task, err := loadTaskFile(fsys, root, displayRoot, file)
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, task)
	}
	return tasks, nil
}

func loadTaskFile(fsys fs.FS, root, displayRoot, file string) (Task, error) {
	readPath := fsPath(root, file)
	data, err := fs.ReadFile(fsys, readPath)
	if err != nil {
		return Task{}, err
	}
	return parseTask(displayPath(displayRoot, file), string(data))
}

func fsPath(parts ...string) string {
	var clean []string
	for _, part := range parts {
		part = strings.Trim(part, "/")
		if part != "" && part != "." {
			clean = append(clean, part)
		}
	}
	if len(clean) == 0 {
		return "."
	}
	return strings.Join(clean, "/")
}

func displayPath(root string, parts ...string) string {
	if root == "" || root == "." {
		return filepath.Join(parts...)
	}
	return filepath.Join(append([]string{root}, parts...)...)
}

func parseTask(path, content string) (Task, error) {
	task := Task{Path: path}
	content = strings.ReplaceAll(content, "\r\n", "\n")
	if !strings.HasPrefix(content, "---\n") {
		return task, fmt.Errorf("automation %s is missing YAML frontmatter", path)
	}
	rest := strings.TrimPrefix(content, "---\n")
	frontmatter, body, found := strings.Cut(rest, "\n---\n")
	if !found {
		return task, fmt.Errorf("automation %s has unterminated YAML frontmatter", path)
	}
	parseTaskFrontmatter(&task, frontmatter)
	if err := validateTaskMetadata(task); err != nil {
		return task, err
	}
	schedule, err := parseSchedule(task.Schedule)
	if err != nil {
		return task, fmt.Errorf("automation %s schedule: %w", path, err)
	}
	task.cron = schedule
	task.Prompt = strings.TrimSpace(body)
	if task.Prompt == "" {
		return task, fmt.Errorf("automation %s has empty prompt body", path)
	}
	return task, nil
}

func parseTaskFrontmatter(task *Task, frontmatter string) {
	for _, line := range strings.Split(frontmatter, "\n") {
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
}

func validateTaskMetadata(task Task) error {
	if task.Name == "" {
		return fmt.Errorf("automation %s is missing name", task.Path)
	}
	if task.Description == "" {
		return fmt.Errorf("automation %s is missing description", task.Path)
	}
	if task.Schedule == "" {
		return fmt.Errorf("automation %s is missing schedule", task.Path)
	}
	return nil
}

func parseSchedule(schedule string) (cron.Schedule, error) {
	schedule = strings.TrimSpace(schedule)
	if strings.HasPrefix(schedule, "cron:") {
		schedule = strings.TrimSpace(strings.TrimPrefix(schedule, "cron:"))
	}
	parser := cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor)
	return parser.Parse(schedule)
}

func taskNames(tasks []Task) string {
	names := make([]string, 0, len(tasks))
	for _, task := range tasks {
		names = append(names, task.Name)
	}
	return strings.Join(names, ",")
}
