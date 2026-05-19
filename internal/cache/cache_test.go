package cache

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFileReadFreshAndWrite(t *testing.T) {
	cacheFile := File{Path: filepath.Join(t.TempDir(), "value.txt"), TTL: time.Hour}
	if err := cacheFile.Write(context.Background(), []byte("cached")); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	entry, ok := cacheFile.ReadFresh(context.Background())
	if !ok {
		t.Fatal("ReadFresh() did not find fresh entry")
	}
	if string(entry.Data) != "cached" || !entry.Fresh || entry.CachePath != cacheFile.Path {
		t.Fatalf("entry = %#v", entry)
	}
}

func TestFileReadFreshRejectsExpiredEntry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "value.txt")
	if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	if _, ok := (File{Path: path, TTL: time.Hour}).ReadFresh(context.Background()); ok {
		t.Fatal("ReadFresh() found expired entry")
	}
}
