package db

import (
	"fmt"
	"io/fs"

	"github.com/pressly/goose/v3"
)

// Migrate runs goose-up against fsys/dir. The caller (typically the store
// package, which owns the //go:embed directive over internal/store/migrations)
// supplies the FS so this package does not need to know where the migration
// files physically live.
//
// Calling Migrate more than once is safe — goose tracks applied versions in
// the schema and only runs pending migrations.
func (d *DB) Migrate(fsys fs.FS, dir string) error {
	if err := goose.SetDialect("sqlite3"); err != nil {
		return fmt.Errorf("set goose dialect: %w", err)
	}
	goose.SetBaseFS(fsys)
	goose.SetLogger(goose.NopLogger())

	if err := goose.Up(d.DB, dir); err != nil {
		return fmt.Errorf("goose up: %w", err)
	}
	return nil
}
