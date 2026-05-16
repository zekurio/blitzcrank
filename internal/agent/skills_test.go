package agent

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadSkillsDeterministic(t *testing.T) {
	root := t.TempDir()
	writeSkill(t, root, "zeta", "zeta")
	writeSkill(t, root, "alpha", "alpha")

	skills, err := LoadSkills(root)
	if err != nil {
		t.Fatalf("LoadSkills() error = %v", err)
	}
	if len(skills) != 2 {
		t.Fatalf("LoadSkills() len = %d, want 2", len(skills))
	}
	if skills[0].Name != "alpha" || skills[1].Name != "zeta" {
		t.Fatalf("skills loaded out of order: %#v", skills)
	}
}

func TestLoadSkillsRequiresFrontmatter(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "broken")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("# Missing frontmatter"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := LoadSkills(root); err == nil {
		t.Fatal("LoadSkills() error = nil, want frontmatter error")
	}
}

func TestLoadSkillsParsesOptionalModel(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "alpha")
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
	content := "---\nname: alpha\ndescription: Test skill\nmodel: gpt-test\nreasoning_effort: high\n---\n\n# Skill\n"
	if err := os.WriteFile(filepath.Join(path, "SKILL.md"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	skills, err := LoadSkills(root)
	if err != nil {
		t.Fatalf("LoadSkills() error = %v", err)
	}
	if skills[0].Model != "gpt-test" {
		t.Fatalf("skill model = %q, want gpt-test", skills[0].Model)
	}
	if skills[0].ReasoningEffort != "high" {
		t.Fatalf("skill reasoning effort = %q, want high", skills[0].ReasoningEffort)
	}
}

func TestModelForRequestUsesSkillModelWhenConfigured(t *testing.T) {
	skills := []Skill{
		{Name: "alpha", Model: "gpt-alpha"},
		{Name: "beta"},
	}
	if got := ModelForRequest(skills, Request{Skill: "alpha"}, "gpt-default"); got != "gpt-alpha" {
		t.Fatalf("ModelForRequest(alpha) = %q, want gpt-alpha", got)
	}
	if got := ModelForRequest(skills, Request{Skill: "beta"}, "gpt-default"); got != "gpt-default" {
		t.Fatalf("ModelForRequest(beta) = %q, want gpt-default", got)
	}
	if got := ModelForRequest(skills, Request{}, "gpt-default"); got != "gpt-default" {
		t.Fatalf("ModelForRequest(no skill) = %q, want gpt-default", got)
	}
}

func TestReasoningEffortForRequestUsesSkillEffortWhenConfigured(t *testing.T) {
	skills := []Skill{
		{Name: "alpha", ReasoningEffort: "high"},
		{Name: "beta"},
	}
	if got := ReasoningEffortForRequest(skills, Request{Skill: "alpha"}, "medium", "gpt-5.5"); got != "high" {
		t.Fatalf("ReasoningEffortForRequest(alpha) = %q, want high", got)
	}
	if got := ReasoningEffortForRequest(skills, Request{Skill: "beta"}, "medium", "gpt-5.5"); got != "medium" {
		t.Fatalf("ReasoningEffortForRequest(beta) = %q, want medium", got)
	}
	if got := ReasoningEffortForRequest(skills, Request{}, "medium", "gpt-5.5"); got != "medium" {
		t.Fatalf("ReasoningEffortForRequest(no skill) = %q, want medium", got)
	}
}

func TestReasoningEffortForRequestUsesRecommendedModelDefault(t *testing.T) {
	tests := []struct {
		model string
		want  string
	}{
		{model: "gpt-5.4-mini", want: "high"},
		{model: "openai/gpt-5.4-mini", want: "high"},
		{model: "gpt-5.4", want: "medium"},
		{model: "openai/gpt-5.5:nitro", want: "low"},
		{model: "unknown-model", want: ""},
	}
	for _, tt := range tests {
		if got := ReasoningEffortForRequest(nil, Request{}, "", tt.model); got != tt.want {
			t.Fatalf("ReasoningEffortForRequest(%q) = %q, want %q", tt.model, got, tt.want)
		}
	}
}

func writeSkill(t *testing.T, root, dir, name string) {
	t.Helper()
	path := filepath.Join(root, dir)
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
	content := "---\nname: " + name + "\ndescription: Test skill\n---\n\n# Skill\n"
	if err := os.WriteFile(filepath.Join(path, "SKILL.md"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
