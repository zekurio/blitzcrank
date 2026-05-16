package assets

import (
	"embed"
	"path/filepath"
	"strings"
)

// FS contains the bundled Markdown inputs used when runtime files are absent.
//
//go:embed prompts/*.md skills/*/SKILL.md automations/*.md
var FS embed.FS

func IsBundledRoot(configured, root string) bool {
	clean := cleanAssetPath(configured)
	return clean == root || strings.HasSuffix(clean, "/share/blitzcrank/"+root)
}

func BundledFilePath(configured, root string) (string, bool) {
	clean := cleanAssetPath(configured)
	if strings.HasPrefix(clean, root+"/") {
		return clean, true
	}
	marker := "/share/blitzcrank/" + root + "/"
	index := strings.LastIndex(clean, marker)
	if index < 0 {
		return "", false
	}
	suffix := strings.TrimPrefix(clean[index+len(marker):], "/")
	if suffix == "" {
		return "", false
	}
	return root + "/" + suffix, true
}

func cleanAssetPath(value string) string {
	clean := filepath.ToSlash(filepath.Clean(strings.TrimSpace(value)))
	return strings.TrimPrefix(clean, "./")
}
