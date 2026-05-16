package tools

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

func (r *Registry) fsStat(path string) (any, error) {
	path, err := r.allowedPath(path)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"path":     path,
		"name":     info.Name(),
		"size":     info.Size(),
		"mode":     info.Mode().String(),
		"is_dir":   info.IsDir(),
		"mod_time": info.ModTime().UTC().Format(time.RFC3339),
	}, nil
}

func (r *Registry) fsList(path string) (any, error) {
	path, err := r.allowedPath(path)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, err
	}
	var out []map[string]any
	for i, entry := range entries {
		if i >= 100 {
			break
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		out = append(out, map[string]any{
			"name":     entry.Name(),
			"path":     filepath.Join(path, entry.Name()),
			"size":     info.Size(),
			"mode":     info.Mode().String(),
			"is_dir":   entry.IsDir(),
			"mod_time": info.ModTime().UTC().Format(time.RFC3339),
		})
	}
	return map[string]any{"path": path, "entries": out}, nil
}

func (r *Registry) fsFindRecent(root string, limit int) (any, error) {
	root, err := r.allowedPath(root)
	if err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	var files []map[string]any
	err = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return nil
		}
		files = append(files, map[string]any{
			"path":     path,
			"size":     info.Size(),
			"mode":     info.Mode().String(),
			"mod_time": info.ModTime().UTC().Format(time.RFC3339),
			"mod_unix": info.ModTime().Unix(),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sortRecent(files)
	if len(files) > limit {
		files = files[:limit]
	}
	for _, file := range files {
		delete(file, "mod_unix")
	}
	return map[string]any{"root": root, "files": files}, nil
}

func (r *Registry) fsDiskUsage(path string) (any, error) {
	path, err := r.allowedPath(path)
	if err != nil {
		return nil, err
	}
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return nil, err
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

func (r *Registry) allowedPath(path string) (string, error) {
	if len(r.cfg.FSAllowedRoots) == 0 {
		return "", fmt.Errorf("filesystem tools are not configured; set FS_TOOL_ALLOWED_ROOTS")
	}
	clean, err := filepath.Abs(strings.TrimSpace(path))
	if err != nil {
		return "", err
	}
	for _, root := range r.cfg.FSAllowedRoots {
		root = strings.TrimSpace(root)
		if root == "" {
			continue
		}
		absRoot, err := filepath.Abs(root)
		if err != nil {
			continue
		}
		rel, err := filepath.Rel(absRoot, clean)
		if err == nil && (rel == "." || (!strings.HasPrefix(rel, ".."+string(filepath.Separator)) && rel != "..")) {
			return clean, nil
		}
	}
	return "", fmt.Errorf("path %q is outside FS_TOOL_ALLOWED_ROOTS", clean)
}

func sortRecent(files []map[string]any) {
	sort.Slice(files, func(i, j int) bool {
		left, _ := files[i]["mod_unix"].(int64)
		right, _ := files[j]["mod_unix"].(int64)
		return left > right
	})
}

func summarizeJellyfinMediaItem(value any) any {
	item, ok := value.(map[string]any)
	if !ok {
		return value
	}

	out := map[string]any{}
	copyIfPresent(out, item, "Id", "id")
	copyIfPresent(out, item, "Name", "name")
	copyIfPresent(out, item, "Type", "type")
	copyIfPresent(out, item, "IndexNumber", "index_number")
	copyIfPresent(out, item, "ParentIndexNumber", "parent_index_number")
	copyIfPresent(out, item, "ProductionYear", "production_year")
	copyIfPresent(out, item, "ProviderIds", "provider_ids")

	sources, _ := item["MediaSources"].([]any)
	if len(sources) == 0 {
		if streams, ok := item["MediaStreams"].([]any); ok && len(streams) > 0 {
			sources = []any{map[string]any{"MediaStreams": streams}}
		}
	}

	mediaSources := make([]map[string]any, 0, len(sources))
	for _, sourceValue := range sources {
		source, ok := sourceValue.(map[string]any)
		if !ok {
			continue
		}
		summary := map[string]any{}
		copyIfPresent(summary, source, "Id", "id")
		copyIfPresent(summary, source, "Name", "name")
		copyIfPresent(summary, source, "Container", "container")
		copyIfPresent(summary, source, "Size", "size")
		copyIfPresent(summary, source, "RunTimeTicks", "run_time_ticks")
		copyIfPresent(summary, source, "VideoType", "video_type")
		copyIfPresent(summary, source, "Protocol", "protocol")
		copyIfPresent(summary, source, "DefaultAudioStreamIndex", "default_audio_stream_index")
		copyIfPresent(summary, source, "DefaultSubtitleStreamIndex", "default_subtitle_stream_index")

		streams, _ := source["MediaStreams"].([]any)
		audio, subtitles, video := summarizeJellyfinStreams(streams)
		summary["audio_tracks"] = audio
		summary["subtitle_tracks"] = subtitles
		summary["video_tracks"] = video
		mediaSources = append(mediaSources, summary)
	}
	out["media_sources"] = mediaSources
	return out
}

func summarizeJellyfinStreams(streams []any) ([]map[string]any, []map[string]any, []map[string]any) {
	audio := []map[string]any{}
	subtitles := []map[string]any{}
	video := []map[string]any{}
	for _, streamValue := range streams {
		stream, ok := streamValue.(map[string]any)
		if !ok {
			continue
		}
		summary := map[string]any{}
		for sourceKey, destKey := range map[string]string{
			"Index":                "index",
			"Type":                 "type",
			"Codec":                "codec",
			"CodecTag":             "codec_tag",
			"Profile":              "profile",
			"Language":             "language",
			"Title":                "title",
			"DisplayTitle":         "display_title",
			"ChannelLayout":        "channel_layout",
			"Channels":             "channels",
			"BitRate":              "bit_rate",
			"SampleRate":           "sample_rate",
			"Width":                "width",
			"Height":               "height",
			"AverageFrameRate":     "average_frame_rate",
			"IsDefault":            "is_default",
			"IsForced":             "is_forced",
			"IsExternal":           "is_external",
			"DeliveryMethod":       "delivery_method",
			"IsTextSubtitleStream": "is_text_subtitle_stream",
		} {
			copyIfPresent(summary, stream, sourceKey, destKey)
		}
		switch strings.ToLower(strings.TrimSpace(fmt.Sprint(stream["Type"]))) {
		case "audio":
			audio = append(audio, summary)
		case "subtitle":
			subtitles = append(subtitles, summary)
		case "video":
			video = append(video, summary)
		}
	}
	return audio, subtitles, video
}

func copyIfPresent(dst, src map[string]any, sourceKey, destKey string) {
	value, ok := src[sourceKey]
	if !ok || value == nil {
		return
	}
	if text, ok := value.(string); ok && strings.TrimSpace(text) == "" {
		return
	}
	dst[destKey] = value
}
