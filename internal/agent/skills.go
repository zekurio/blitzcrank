package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type Skill struct {
	Name            string
	Description     string
	Model           string
	ReasoningEffort string
	Body            string
	Path            string
}

func LoadSkills(root string) ([]Skill, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, fmt.Errorf("load skills from %s: %w", root, err)
	}

	var dirs []string
	for _, entry := range entries {
		if entry.IsDir() {
			dirs = append(dirs, entry.Name())
		}
	}
	sort.Strings(dirs)

	skills := make([]Skill, 0, len(dirs))
	for _, dir := range dirs {
		path := filepath.Join(root, dir, "SKILL.md")
		content, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("load skill %s: %w", dir, err)
		}
		skill, err := parseSkill(path, string(content))
		if err != nil {
			return nil, err
		}
		skills = append(skills, skill)
	}
	if len(skills) == 0 {
		return nil, fmt.Errorf("no skills found in %s", root)
	}
	return skills, nil
}

func parseSkill(path, content string) (Skill, error) {
	var skill Skill
	skill.Path = path

	content = strings.ReplaceAll(content, "\r\n", "\n")
	if !strings.HasPrefix(content, "---\n") {
		return skill, fmt.Errorf("skill %s is missing YAML frontmatter", path)
	}
	rest := strings.TrimPrefix(content, "---\n")
	frontmatter, body, found := strings.Cut(rest, "\n---\n")
	if !found {
		return skill, fmt.Errorf("skill %s has unterminated YAML frontmatter", path)
	}

	for _, line := range strings.Split(frontmatter, "\n") {
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		switch strings.TrimSpace(key) {
		case "name":
			skill.Name = value
		case "description":
			skill.Description = value
		case "model":
			skill.Model = value
		case "reasoning_effort":
			skill.ReasoningEffort = value
		}
	}
	if skill.Name == "" {
		return skill, fmt.Errorf("skill %s is missing name", path)
	}
	if skill.Description == "" {
		return skill, fmt.Errorf("skill %s is missing description", path)
	}
	skill.Body = strings.TrimSpace(body)
	return skill, nil
}
