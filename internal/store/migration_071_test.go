package store

import (
	"context"
	"database/sql"
	"testing"

	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"
)

// TestMigration071_BackfillsExistingSettingsRow covers the Phase 2c first-run
// flag: migration 071 adds settings.first_run_complete with a default of 0
// (so a fresh row would be NOT-COMPLETE), then opts out the singleton row that
// migration 006 inserts so server installs never trip the firstrun overlay.
// The mobile bootstrap will separately gate on user-row existence to detect
// the fresh-install case.
func TestMigration071_BackfillsExistingSettingsRow(t *testing.T) {
	t.Setenv("ALLOWED_USER_ID", "42")

	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	if err := goose.SetDialect("sqlite3"); err != nil {
		t.Fatalf("set dialect: %v", err)
	}
	goose.SetBaseFS(embedMigrations)
	goose.SetLogger(goose.NopLogger())

	ctx := context.Background()

	if err := goose.UpToContext(ctx, db, "migrations", 70); err != nil {
		t.Fatalf("goose up to 70: %v", err)
	}

	// Confirm the column doesn't exist yet — guards against accidental
	// re-ordering of migrations.
	if columnExists(t, db, "settings", "first_run_complete") {
		t.Fatal("first_run_complete should not exist before migration 071")
	}

	if err := goose.UpToContext(ctx, db, "migrations", 71); err != nil {
		t.Fatalf("goose up to 71: %v", err)
	}

	if !columnExists(t, db, "settings", "first_run_complete") {
		t.Fatal("first_run_complete should exist after migration 071")
	}

	// Singleton row inserted by migration 006 must be opted-out by the backfill.
	var flag int
	if err := db.QueryRow(`SELECT first_run_complete FROM settings WHERE id = 1`).Scan(&flag); err != nil {
		t.Fatalf("read backfilled flag: %v", err)
	}
	if flag != 1 {
		t.Errorf("expected backfill to set first_run_complete=1 for the singleton row, got %d", flag)
	}
}

// TestMigration071_RoundTrip exercises goose Up → Down → Up across migration
// 071. Down must remove the column; Up must re-add it and re-run the backfill.
func TestMigration071_RoundTrip(t *testing.T) {
	t.Setenv("ALLOWED_USER_ID", "42")

	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	if err := goose.SetDialect("sqlite3"); err != nil {
		t.Fatalf("set dialect: %v", err)
	}
	goose.SetBaseFS(embedMigrations)
	goose.SetLogger(goose.NopLogger())

	ctx := context.Background()

	if err := goose.UpToContext(ctx, db, "migrations", 71); err != nil {
		t.Fatalf("goose up to 71: %v", err)
	}
	if !columnExists(t, db, "settings", "first_run_complete") {
		t.Fatal("column missing after first up")
	}

	if err := goose.DownToContext(ctx, db, "migrations", 70); err != nil {
		t.Fatalf("goose down to 70: %v", err)
	}
	if columnExists(t, db, "settings", "first_run_complete") {
		t.Fatal("column should be dropped after down to 70")
	}

	if err := goose.UpToContext(ctx, db, "migrations", 71); err != nil {
		t.Fatalf("goose re-up to 71: %v", err)
	}
	if !columnExists(t, db, "settings", "first_run_complete") {
		t.Fatal("column missing after re-up")
	}

	// Backfill must run again on re-up.
	var flag int
	if err := db.QueryRow(`SELECT first_run_complete FROM settings WHERE id = 1`).Scan(&flag); err != nil {
		t.Fatalf("read re-up flag: %v", err)
	}
	if flag != 1 {
		t.Errorf("expected re-up backfill to set first_run_complete=1, got %d", flag)
	}
}

