package assets

import (
	"embed"
)

// FS contains the bundled Markdown inputs.
// Prompts and skills are always loaded from this embedded filesystem by the
// live agent; only extra automation directories are appended at runtime.
//
//go:embed prompts/*.md skills/*/SKILL.md automations/*.md
var FS embed.FS
