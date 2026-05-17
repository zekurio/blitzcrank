package codex

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"syscall"

	"blitzcrank/internal/config"
)

func loadCodexCredential(cfg config.Config) (CodexCredential, error) {
	path := AuthPath(cfg)
	unlock, err := lockAuthStore(path)
	if err != nil {
		return CodexCredential{}, err
	}
	defer unlock()

	store, err := loadAuthStoreUnlocked(path)
	if err != nil {
		return CodexCredential{}, err
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
		return err
	}
	defer unlock()

	store, err := loadAuthStoreUnlocked(path)
	if err != nil {
		return err
	}
	store.Profiles[cfg.CodexAuthProfile] = cred
	return saveAuthStoreUnlocked(path, store)
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
		return AuthStore{}, err
	}
	var store AuthStore
	if err := json.Unmarshal(data, &store); err != nil {
		return AuthStore{}, err
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
		return err
	}
	if info.Mode().Perm()&0o077 == 0 {
		return nil
	}
	return os.Chmod(path, 0o600)
}

func saveAuthStoreUnlocked(path string, store AuthStore) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func lockAuthStore(path string) (func(), error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	lockPath := path + ".lock"
	file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX); err != nil {
		_ = file.Close()
		return nil, err
	}
	return func() {
		_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
		_ = file.Close()
	}, nil
}
