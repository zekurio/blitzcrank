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

	return json.NewEncoder(f).Encode(cmds)
}

func (s *SimpleCommandStore) Load() (cmds map[string]string, err error) {
	cmds = map[string]string{}

	f, err := os.Open(s.loc)
	if err != nil {
		if err != nil {
			if os.IsNotExist(err) { // handle first run
				err = nil
			}
			return
		}
	}

	defer f.Close()

	err = json.NewDecoder(f).Decode(&cmds)
	return
}
