//go:build !windows

package tools

import (
	"fmt"
	"syscall"
)

func (r *Registry) fsDiskUsage(path string) (any, error) {
	path, err := r.allowedPath(path)
	if err != nil {
		return nil, err
	}
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return nil, fmt.Errorf("stat filesystem %s: %w", path, err)
	}
	total := stat.Blocks * uint64(stat.Bsize)
	free := stat.Bavail * uint64(stat.Bsize)
	return map[string]any{
		"path":        path,
		"total_bytes": total,
		"free_bytes":  free,
		"used_bytes":  total - free,
	}, nil
}
