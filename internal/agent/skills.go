package agent

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"blitzcrank/internal/config"
)

type Skill struct {
	Name        string
	Description string
	Body        string
	Path        string
	Prompt      string
}

func LoadEmbeddedSkills() ([]Skill, error) {
	return LoadSkills(localMarkdownDir("skills"))
}

func LoadRuntimeSkills(cfg config.Config) ([]Skill, error) {
	if root := strings.TrimSpace(cfg.SkillsDirectory); root != "" {
		skills, err := LoadSkills(root)
		if err == nil {
			return skills, nil
		}
		return nil, err
	}
	return LoadEmbeddedSkills()
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

func LoadSkills(root string) ([]Skill, error) {
	skills, err := loadSkillsFromFS(os.DirFS(root), ".", root)
	if err == nil {
		return skills, nil
	}
	return nil, fmt.Errorf("load skills from %s: %w", root, err)
}

func loadSkillsFromFS(fsys fs.FS, root, displayRoot string) ([]Skill, error) {
	entries, err := fs.ReadDir(fsys, root)
	if err != nil {
		return nil, err
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
		readPath := fsPath(root, dir, "SKILL.md")
		content, err := fs.ReadFile(fsys, readPath)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			return nil, fmt.Errorf("load skill %s: %w", dir, err)
		}
		skill, err := parseSkill(displayPath(displayRoot, dir, "SKILL.md"), string(content))
		if err != nil {
			return nil, err
		}
		if skill.Name != dir {
			return nil, fmt.Errorf("skill %s name %q must match directory %q", skill.Path, skill.Name, dir)
		}
		skills = append(skills, skill)
	}
	if len(skills) == 0 {
		return nil, fmt.Errorf("no skills found in %s", root)
	}
	return skills, nil
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
		}
	}
	if skill.Name == "" {
		return skill, fmt.Errorf("skill %s is missing name", path)
	}
	if skill.Description == "" {
		return skill, fmt.Errorf("skill %s is missing description", path)
	}
	skill.Body = strings.TrimSpace(body)
	skill.Prompt = formatSkillPrompt(skill)
	return skill, nil
}
