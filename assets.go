package assets

import (
	"embed"
)

//go:embed automations/*.md prompts/*.md skills/*/SKILL.md
var FS embed.FS
