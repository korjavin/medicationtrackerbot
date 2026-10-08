// Package db owns the shared SQLite connection used by the cloud storage
// layer (internal/cloudstore).
//
// One *DB is opened by the composition root (cmd/cloud) and
// passed into each repository constructor. Holding a single *sql.DB means a
// single connection pool, a single busy-timeout, and a single WAL writer —
// which is the property the SQLite max-conns=1 strategy relies on.
package db

import (
	"database/sql"
	"fmt"
	"log/slog"

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
// Migrations are NOT run here — see (*DB).Migrate. Callers that need a
// populated schema run migrations on their own behalf (cloudstore.New runs
// Migrate over its embedded migrations).
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
	// time for concurrent writes to succeed.
	if _, err := sdb.Exec("PRAGMA busy_timeout = 5000"); err != nil {
		return nil, fmt.Errorf("failed to set busy_timeout: %w", err)
	}

	if err := ensureIncrementalAutoVacuum(sdb); err != nil {
		return nil, err
	}

	// Limit connection pool to 1 to avoid multiple connections racing each
	// other for the WAL write lock in concurrent-write scenarios.
	sdb.SetMaxOpenConns(1)

	return &DB{DB: sdb}, nil
}

// ensureIncrementalAutoVacuum switches the file to auto_vacuum=INCREMENTAL so
// churn deletes (oplog compaction, inbox acks) can hand pages back to the OS
// via PRAGMA incremental_vacuum (see cloudstore.PutSnapshot). Changing the
// mode on an existing file only takes effect after a full VACUUM, so a file
// still at NONE/FULL is rewritten once here; every later open is a no-op.
// The VACUUM holds the write lock for the rewrite (seconds for a ~100MB file)
// and goes through the WAL, so litestream replicates it as one large burst.
func ensureIncrementalAutoVacuum(sdb *sql.DB) error {
	var mode int
	if err := sdb.QueryRow("PRAGMA auto_vacuum").Scan(&mode); err != nil {
		return fmt.Errorf("read auto_vacuum: %w", err)
	}
	if mode == 2 { // INCREMENTAL
		return nil
	}
	pagesBefore, freeBefore := pageStats(sdb)
	if _, err := sdb.Exec("PRAGMA auto_vacuum = INCREMENTAL"); err != nil {
		return fmt.Errorf("set auto_vacuum: %w", err)
	}
	if _, err := sdb.Exec("VACUUM"); err != nil {
		return fmt.Errorf("vacuum to enable auto_vacuum: %w", err)
	}
	if pagesBefore > 1 { // ponytail: brand-new files convert silently
		pagesAfter, freeAfter := pageStats(sdb)
		slog.Info("sqlite converted to auto_vacuum=INCREMENTAL (one-time VACUUM)",
			"pages_before", pagesBefore, "freelist_before", freeBefore,
			"pages_after", pagesAfter, "freelist_after", freeAfter)
	}
	return nil
}

func pageStats(sdb *sql.DB) (pages, free int64) {
	_ = sdb.QueryRow("PRAGMA page_count").Scan(&pages)
	_ = sdb.QueryRow("PRAGMA freelist_count").Scan(&free)
	return pages, free
}
