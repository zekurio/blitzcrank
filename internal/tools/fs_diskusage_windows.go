//go:build windows

package tools

import (
	"fmt"
	"path/filepath"

	"golang.org/x/sys/windows"
)

func (r *Registry) fsDiskUsage(path string) (any, error) {
	path, err := r.allowedPath(path)
	if err != nil {
		return nil, err
	}
	root := filepath.VolumeName(path) + `\`
	rootPtr, err := windows.UTF16PtrFromString(root)
	if err != nil {
		return nil, fmt.Errorf("convert volume path %s: %w", root, err)
	}
	var freeAvailable, total, free uint64
	if err := windows.GetDiskFreeSpaceEx(rootPtr, &freeAvailable, &total, &free); err != nil {
		return nil, fmt.Errorf("get disk usage for %s: %w", root, err)
	}
	return map[string]any{
		"path":        path,
		"total_bytes": total,
		"free_bytes":  freeAvailable,
		"used_bytes":  total - free,
	}, nil
}
