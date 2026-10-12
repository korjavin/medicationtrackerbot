package db

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

// newTestDB opens an in-memory SQLite and creates a one-column table for the
// WithTx round-trip tests. The schema is intentionally trivial — we are
// exercising commit/rollback semantics, not domain SQL.
func newTestDB(t *testing.T) *DB {
	t.Helper()
	d, err := Open(":memory:")
	if err != nil {
		t.Fatalf("Open(:memory:): %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })

	if _, err := d.Exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, val TEXT)`); err != nil {
		t.Fatalf("create table: %v", err)
	}
	return d
}

func countItems(t *testing.T, d *DB) int {
	t.Helper()
	var n int
	if err := d.QueryRow(`SELECT COUNT(*) FROM items`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

func TestWithTx_CommitsOnNilError(t *testing.T) {
	d := newTestDB(t)

	err := d.WithTx(context.Background(), func(tx TX) error {
		if _, err := tx.Exec(`INSERT INTO items (val) VALUES ('a')`); err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO items (val) VALUES ('b')`); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		t.Fatalf("WithTx: %v", err)
	}

	if got := countItems(t, d); got != 2 {
		t.Fatalf("expected 2 items after commit, got %d", got)
	}
}

func TestWithTx_RollsBackOnError(t *testing.T) {
	d := newTestDB(t)

	sentinel := errors.New("fn failed")
	err := d.WithTx(context.Background(), func(tx TX) error {
		if _, err := tx.Exec(`INSERT INTO items (val) VALUES ('a')`); err != nil {
			return err
		}
		return sentinel
	})
	if !errors.Is(err, sentinel) {
		t.Fatalf("expected sentinel error, got %v", err)
	}

	if got := countItems(t, d); got != 0 {
		t.Fatalf("expected 0 items after rollback, got %d", got)
	}
}

func TestWithTx_RollsBackOnPanic(t *testing.T) {
	d := newTestDB(t)

	func() {
		defer func() {
			if r := recover(); r == nil {
				t.Fatalf("expected panic to propagate")
			}
		}()
		_ = d.WithTx(context.Background(), func(tx TX) error {
			if _, err := tx.Exec(`INSERT INTO items (val) VALUES ('a')`); err != nil {
				t.Fatalf("insert: %v", err)
			}
			panic("boom")
		})
	}()

	if got := countItems(t, d); got != 0 {
		t.Fatalf("expected 0 items after panic rollback, got %d", got)
	}
}

func TestWithTx_RollsBackOnCtxCancelInsideFn(t *testing.T) {
	d := newTestDB(t)

	ctx, cancel := context.WithCancel(context.Background())
	err := d.WithTx(ctx, func(tx TX) error {
		if _, err := tx.Exec(`INSERT INTO items (val) VALUES ('a')`); err != nil {
			return err
		}
		cancel()
		// After cancel, ExecContext should fail; this ensures the rollback
		// branch handles a context-driven error from inside fn.
		_, err := tx.ExecContext(ctx, `INSERT INTO items (val) VALUES ('b')`)
		return err
	})
	if err == nil {
		t.Fatalf("expected error after cancel, got nil")
	}

	if got := countItems(t, d); got != 0 {
		t.Fatalf("expected 0 items after rollback, got %d", got)
	}
}

// A read-then-write WithTx must wait out another connection's write lock
// (BEGIN IMMEDIATE + busy_timeout) instead of failing with SQLITE_BUSY.
func TestWithTx_WaitsForExternalWriter(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.db")
	d, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if _, err := d.Exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, val TEXT)`); err != nil {
		t.Fatal(err)
	}

	ext, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ext.Close() })
	ext.SetMaxOpenConns(1)
	conn, err := ext.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
		t.Fatal(err)
	}
	go func() {
		time.Sleep(300 * time.Millisecond)
		_, _ = conn.ExecContext(context.Background(), "COMMIT")
		_ = conn.Close()
	}()

	err = d.WithTx(context.Background(), func(tx TX) error {
		var n int
		if err := tx.QueryRow(`SELECT COUNT(*) FROM items`).Scan(&n); err != nil {
			return err
		}
		_, err := tx.Exec(`INSERT INTO items (val) VALUES ('x')`)
		return err
	})
	if err != nil {
		t.Fatalf("WithTx should wait for the external writer, got: %v", err)
	}
}
