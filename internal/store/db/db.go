// Package db owns the shared SQLite connection used by every per-domain
// repository under internal/store/.
//
// One *DB is opened by the composition root (cmd/bot, cmd/mcptool, etc.) and
// passed into each repository constructor. Holding a single *sql.DB means a
// single connection pool, a single busy-timeout, and a single WAL writer —
// which is the property the SQLite max-conns=1 strategy relies on.
package db

import (
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite" // Pure Go SQLite driver
)

// DB is the shared SQLite connection. It embeds *sql.DB so repositories can
// call Query/Exec/QueryRow/BeginTx through the embedded methods without an
// extra accessor.
type DB struct {
	*sql.DB
}

// Open opens a SQLite database at the given path with the project's standard
// pragmas (WAL journal, 5s busy_timeout) and connection-pool limit
// (MaxOpenConns=1, to avoid WAL-writer contention).
//
// Migrations are NOT run here — see (*DB).Migrate. Tests and importers that
// need a populated schema typically go through store.NewWithDB which runs
// migrations on the caller's behalf.
func Open(path string) (*DB, error) {
	sdb, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	if err := sdb.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	// Enable WAL mode for Litestream compatibility.
	if _, err := sdb.Exec("PRAGMA journal_mode=WAL"); err != nil {
		return nil, fmt.Errorf("failed to enable WAL mode: %w", err)
	}

	// Set busy_timeout so concurrent writers retry instead of immediately
	// returning SQLITE_BUSY ("database is locked"). 5 seconds gives enough
	// time for the scheduler's simultaneous reminder writes to succeed.
	if _, err := sdb.Exec("PRAGMA busy_timeout = 5000"); err != nil {
		return nil, fmt.Errorf("failed to set busy_timeout: %w", err)
	}

	// Limit connection pool to 1 to avoid multiple connections racing each
	// other for the WAL write lock in concurrent-write scenarios.
	sdb.SetMaxOpenConns(1)

	return &DB{DB: sdb}, nil
}
