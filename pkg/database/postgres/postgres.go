package postgres

import (
	"database/sql"
	"fmt"

	"github.com/zekurio/blitzcrank/pkg/database"
)

type PostgresConf struct {
	Host     string
	Port     int
	User     string
	Password string
	Database string
}

type Postgres struct {
	db *sql.DB
}

var _ database.Database = &Postgres{}

func NewPostgres(c PostgresConf) (*Postgres, error) {
	var (
		t   Postgres
		err error
	)

	dsn := fmt.Sprintf("host=%s port=%d dbname=%s user=%s password=%s sslmode=disable",
		c.Host, c.Port, c.Database, c.User, c.Password)
	t.db, err = sql.Open("postgres", dsn)
	if err != nil {
		return nil, err
	}

	err = t.db.Ping()
	if err != nil {
		return nil, err
	}

	return &t, nil
}

func (p *Postgres) Close() (err error) {
	return p.db.Close()
}
