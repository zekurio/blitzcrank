package store

// CommandStore is the storage for our cache command
type CommandStore interface {
	Store(cmds map[string]string) (err error)

	Load() (cmds map[string]string, err error)
}
