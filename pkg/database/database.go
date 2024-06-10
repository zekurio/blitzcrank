package database

import "context"

type Database interface {
	Connect(ctx context.Context, cfg Conf) error
	Close() error

	Get()
}
