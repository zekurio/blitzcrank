package assets

import (
	"embed"
)

//go:embed prompts/*.md
var FS embed.FS
