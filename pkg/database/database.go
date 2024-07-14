package database

type Database interface {
	Close() (err error)
}
