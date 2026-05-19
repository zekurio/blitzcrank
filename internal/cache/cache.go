package cache

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const DefaultDirName = "blitzcrank"

type File struct {
	Path string
	TTL  time.Duration
}

type Entry struct {
	Data      []byte
	Modified  time.Time
	Fresh     bool
	CachePath string
}

func UserPath(name string) string {
	name = strings.Trim(strings.TrimSpace(name), string(filepath.Separator))
	if name == "" {
		return ""
	}
	dir := UserDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, name)
}

func UserDir() string {
	cacheDir, err := os.UserCacheDir()
	if err != nil || strings.TrimSpace(cacheDir) == "" {
		return ""
	}
	return filepath.Join(cacheDir, DefaultDirName)
}

func (f File) Read(ctx context.Context) (Entry, error) {
	select {
	case <-ctx.Done():
		return Entry{}, ctx.Err()
	default:
	}
	path := strings.TrimSpace(f.Path)
	if path == "" {
		return Entry{}, os.ErrNotExist
	}
	info, err := os.Stat(path)
	if err != nil {
		return Entry{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return Entry{}, err
	}
	return Entry{
		Data:      data,
		Modified:  info.ModTime(),
		Fresh:     f.TTL <= 0 || time.Since(info.ModTime()) <= f.TTL,
		CachePath: path,
	}, nil
}

func (f File) ReadFresh(ctx context.Context) (Entry, bool) {
	entry, err := f.Read(ctx)
	return entry, err == nil && entry.Fresh
}

func (f File) Write(ctx context.Context, data []byte) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	path := strings.TrimSpace(f.Path)
	if path == "" {
		return os.ErrNotExist
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

func FetchBytes(ctx context.Context, client *http.Client, method, rawURL string, headers map[string]string, maxBytes int64) ([]byte, error) {
	if client == nil {
		client = http.DefaultClient
	}
	if maxBytes <= 0 {
		maxBytes = 8 << 20
	}
	req, err := http.NewRequestWithContext(ctx, method, rawURL, nil)
	if err != nil {
		return nil, err
	}
	for key, value := range headers {
		if strings.TrimSpace(value) != "" {
			req.Header.Set(key, value)
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("%s response exceeded %d bytes", rawURL, maxBytes)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("%s failed: %s: %s", rawURL, resp.Status, strings.TrimSpace(string(data)))
	}
	return data, nil
}
