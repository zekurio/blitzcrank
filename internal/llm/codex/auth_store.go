package codex

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"blitzcrank/internal/config"
)

func loadCodexCredential(cfg config.Config) (CodexCredential, error) {
	path := AuthPath(cfg)
	unlock, err := lockAuthStore(path)
	if err != nil {
		return CodexCredential{}, fmt.Errorf("lock Codex auth store: %w", err)
	}
	defer unlock()

	store, err := loadAuthStoreUnlocked(path)
	if err != nil {
		return CodexCredential{}, fmt.Errorf("load Codex auth store: %w", err)
	}
	cred, ok := store.Profiles[cfg.CodexAuthProfile]
	if !ok {
		return CodexCredential{}, fmt.Errorf("no Codex credentials for profile %q; run `blitzcrank codex login`", cfg.CodexAuthProfile)
	}
	return cred, nil
}

func saveCodexCredential(cfg config.Config, cred CodexCredential) error {
	path := AuthPath(cfg)
	unlock, err := lockAuthStore(path)
	if err != nil {
		return fmt.Errorf("lock Codex auth store: %w", err)
	}
	defer unlock()

	store, err := loadAuthStoreUnlocked(path)
	if err != nil {
		return fmt.Errorf("load Codex auth store: %w", err)
	}
	store.Profiles[cfg.CodexAuthProfile] = cred
	if err := saveAuthStoreUnlocked(path, store); err != nil {
		return fmt.Errorf("save Codex auth store: %w", err)
	}
	return nil
}

func loadAuthStoreUnlocked(path string) (AuthStore, error) {
	if err := tightenAuthStorePermissions(path); err != nil {
		return AuthStore{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return AuthStore{Version: 1, Profiles: map[string]CodexCredential{}}, nil
		}
		return AuthStore{}, fmt.Errorf("read %s: %w", path, err)
	}
	var store AuthStore
	if err := json.Unmarshal(data, &store); err != nil {
		return AuthStore{}, fmt.Errorf("parse %s: %w", path, err)
	}
	if store.Profiles == nil {
		store.Profiles = map[string]CodexCredential{}
	}
	if store.Version == 0 {
		store.Version = 1
	}
	return store, nil
}

func tightenAuthStorePermissions(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("stat %s: %w", path, err)
	}
	if info.Mode().Perm()&0o077 == 0 {
		return nil
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return fmt.Errorf("chmod %s: %w", path, err)
	}
	return nil
}

func saveAuthStoreUnlocked(path string, store AuthStore) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create auth store directory: %w", err)
	}
	data, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return fmt.Errorf("encode auth store: %w", err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("replace %s: %w", path, err)
	}
	return nil
}
