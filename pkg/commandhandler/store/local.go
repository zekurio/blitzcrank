package store

import (
	"encoding/json"
	"os"
)

// SimpleCommandStore is a simple, local implementation of the CommandStore interface
type SimpleCommandStore struct {
	loc string
}

var _ CommandStore = (*SimpleCommandStore)(nil)

func NewSimpleCommandStore(loc string) *SimpleCommandStore {
	return &SimpleCommandStore{loc}
}

func NewDefault() *SimpleCommandStore {
	return NewSimpleCommandStore(".cachedCommands.json")
}

func (s *SimpleCommandStore) Store(cmds map[string]string) (err error) {
	f, err := os.Create(s.loc)
	if err != nil {
		return
	}

	defer f.Close()

	err = json.NewEncoder(f).Encode(cmds)
	return
}

func (s *SimpleCommandStore) Load() (cmds map[string]string, err error) {
	f, err := os.Open(s.loc)
	if err != nil {
		return
	}

	defer f.Close()

	err = json.NewDecoder(f).Decode(&cmds)
	return
}
