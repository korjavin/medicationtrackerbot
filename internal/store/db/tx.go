package db

import (
	"context"
	"database/sql"
	"fmt"
)

// TX is the read/write surface common to *sql.DB and *sql.Tx. Repository
// helpers that need to participate in either a free-standing query or a
// caller-owned transaction accept a TX so the same SQL path serves both cases.
//
// This is the seam that lets one repository's transaction span SQL owned by
// another repository: the outer call uses (*DB).WithTx, and each inner
// repository helper accepts the *sql.Tx (which satisfies TX) it was handed.
type TX interface {
	QueryRow(query string, args ...any) *sql.Row
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	Query(query string, args ...any) (*sql.Rows, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	Exec(query string, args ...any) (sql.Result, error)
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// Compile-time checks that the two concrete implementations satisfy TX.
var (
	_ TX = (*sql.DB)(nil)
	_ TX = (*sql.Tx)(nil)
)

// WithTx runs fn inside a transaction. The transaction is committed on a nil
// return, rolled back on a non-nil return, and rolled back via a deferred
// Rollback (suppressed if Commit already ran) on panic — re-raising the panic
// so the caller still sees it.
func (d *DB) WithTx(ctx context.Context, fn func(TX) error) (err error) {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() {
		if p := recover(); p != nil {
			_ = tx.Rollback()
			panic(p)
		}
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	if err = fn(tx); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}
	return nil
}
