package store

import (
	"context"
	"database/sql"
	"testing"

	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"
)

// TestMigration071_BackfillsExistingSettingsRow covers the Phase 2c first-run
// flag: migration 071 adds settings.first_run_complete with DEFAULT 0 and then
// backfills the singleton row to 1 only when medications already exist. The
// medications presence check is the "this DB is in use" signal — existing
// installs (server or already-onboarded mobile) keep flag=1 and never see the
// overlay; truly fresh installs keep flag=0 and surface the onboarding flow.
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

	// Seed a medication row so this DB looks like an existing install. The
	// UPDATE in migration 071 only backfills when medications has at least
	// one row, so this is the precondition for the flag=1 assertion below.
	if _, err := db.Exec(`INSERT INTO medications (name) VALUES ('seed-med')`); err != nil {
		t.Fatalf("seed medications row: %v", err)
	}

	if err := goose.UpToContext(ctx, db, "migrations", 71); err != nil {
		t.Fatalf("goose up to 71: %v", err)
	}

	if !columnExists(t, db, "settings", "first_run_complete") {
		t.Fatal("first_run_complete should exist after migration 071")
	}

	var flag int
	if err := db.QueryRow(`SELECT first_run_complete FROM settings WHERE id = 1`).Scan(&flag); err != nil {
		t.Fatalf("read backfilled flag: %v", err)
	}
	if flag != 1 {
		t.Errorf("expected backfill to set first_run_complete=1 for the singleton row when medications exist, got %d", flag)
	}
}

// TestMigration071_FreshInstallKeepsFlagZero confirms the inverse: when no
// medications exist at migration time, the singleton row stays at the
// DEFAULT 0 value so the bootstrap fires needs_first_run=true on the very
// first launch of a fresh mobile install.
func TestMigration071_FreshInstallKeepsFlagZero(t *testing.T) {
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

	var flag int
	if err := db.QueryRow(`SELECT first_run_complete FROM settings WHERE id = 1`).Scan(&flag); err != nil {
		t.Fatalf("read flag: %v", err)
	}
	if flag != 0 {
		t.Errorf("expected first_run_complete=0 on fresh DB with no medications, got %d", flag)
	}
}

// TestMigration071_RoundTrip exercises goose Up → Down → Up across migration
// 071 against a DB that already contains medication data. Down must remove
// the column; Up must re-add it and re-run the backfill.
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

	// Need medications to exist before 071 so the backfill runs.
	if err := goose.UpToContext(ctx, db, "migrations", 70); err != nil {
		t.Fatalf("goose up to 70: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO medications (name) VALUES ('seed-med')`); err != nil {
		t.Fatalf("seed medications row: %v", err)
	}

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

	var flag int
	if err := db.QueryRow(`SELECT first_run_complete FROM settings WHERE id = 1`).Scan(&flag); err != nil {
		t.Fatalf("read re-up flag: %v", err)
	}
	if flag != 1 {
		t.Errorf("expected re-up backfill to set first_run_complete=1, got %d", flag)
	}
}
