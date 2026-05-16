package store

import (
	"database/sql"
	"fmt"
	"time"
)

func formatTime(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}

func formatTimePtr(value *time.Time) any {
	if value == nil {
		return nil
	}
	return formatTime(*value)
}

func scanTime(target *time.Time) any {
	return sqlScannerFunc(func(src any) error {
		value, ok := src.(string)
		if !ok {
			if bytes, ok := src.([]byte); ok {
				value = string(bytes)
			} else {
				return fmt.Errorf("unexpected time value %T", src)
			}
		}
		parsed, err := time.Parse(time.RFC3339Nano, value)
		if err != nil {
			return err
		}
		*target = parsed
		return nil
	})
}

func parseNullTime(value sql.NullString) *time.Time {
	if !value.Valid || value.String == "" {
		return nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, value.String)
	if err != nil {
		return nil
	}
	return &parsed
}

type sqlScannerFunc func(any) error

func (f sqlScannerFunc) Scan(src any) error {
	return f(src)
}
