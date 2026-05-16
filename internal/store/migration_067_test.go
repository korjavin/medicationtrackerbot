package store

import (
	"context"
	"database/sql"
	"testing"

	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"
)

// TestMigration067_AddsPartialUniqueIndex covers Track D Task 10's
// idempotency primitive: migration 067 adds a partial unique index over
// (tz_plan_id, tz_step_number) restricted to rows where tz_plan_id IS NOT
// NULL. The index makes INSERT OR IGNORE on materialize and the one-shot
// backfill safe to retry without producing duplicate rows.
func TestMigration067_AddsPartialUniqueIndex(t *testing.T) {
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

	if err := goose.UpToContext(ctx, db, "migrations", 67); err != nil {
		t.Fatalf("goose up to 67: %v", err)
	}

	if !indexExists(t, db, "idx_intake_log_tz_plan_step_unique") {
		t.Fatal("idx_intake_log_tz_plan_step_unique should exist after migration 067")
	}

	// Seed a medication so the FK passes (well, FKs are off but keep schema honest).
	if _, err := db.Exec(
		`INSERT INTO medications (id, name, dosage, schedule) VALUES (1, 'M', '10mg', '08:00')`,
	); err != nil {
		t.Fatalf("insert medication: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO tz_transition_plans (id, old_tz, new_tz, status, steps_json, inputs_json, plan_hash)
		 VALUES (1, 'UTC', 'Europe/Berlin', 'APPROVED', '[]', '{}', 'h1')`,
	); err != nil {
		t.Fatalf("insert plan: %v", err)
	}

	// First insert with (tz_plan_id=1, tz_step_number=2) succeeds.
	if _, err := db.Exec(
		`INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, status, source, tz_plan_id, tz_step_number)
		 VALUES (1, 1, 1000, 'PENDING', 'tz_step', 1, 2)`,
	); err != nil {
		t.Fatalf("first insert: %v", err)
	}

	// Second insert with the same (tz_plan_id, tz_step_number) must fail.
	if _, err := db.Exec(
		`INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, status, source, tz_plan_id, tz_step_number)
		 VALUES (1, 1, 2000, 'PENDING', 'tz_step', 1, 2)`,
	); err == nil {
		t.Errorf("duplicate (tz_plan_id, tz_step_number) insert should violate unique index, got nil error")
	}

	// INSERT OR IGNORE should silently no-op rather than error.
	if _, err := db.Exec(
		`INSERT OR IGNORE INTO intake_log (medication_id, user_id, scheduled_at_unix, status, source, tz_plan_id, tz_step_number)
		 VALUES (1, 1, 3000, 'PENDING', 'tz_step', 1, 2)`,
	); err != nil {
		t.Errorf("INSERT OR IGNORE should not error on duplicate: %v", err)
	}

	// The partial WHERE clause must NOT block normal source='schedule'
	// rows (tz_plan_id IS NULL). Two NULL/NULL rows are allowed.
	if _, err := db.Exec(
		`INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, status, source) VALUES (1, 1, 4000, 'PENDING', 'schedule')`,
	); err != nil {
		t.Fatalf("schedule row 1 should succeed: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, status, source) VALUES (1, 1, 5000, 'PENDING', 'schedule')`,
	); err != nil {
		t.Errorf("schedule row 2 should succeed (partial index excludes NULL tz_plan_id): %v", err)
	}
}

// TestMigration067_RoundTrip exercises goose Up → Down → Up across migration
// 067. The index must drop on Down and reappear on Up.
func TestMigration067_RoundTrip(t *testing.T) {
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

	if err := goose.UpToContext(ctx, db, "migrations", 67); err != nil {
		t.Fatalf("goose up to 67: %v", err)
	}
	if !indexExists(t, db, "idx_intake_log_tz_plan_step_unique") {
		t.Fatal("index missing after first up")
	}

	if err := goose.DownToContext(ctx, db, "migrations", 66); err != nil {
		t.Fatalf("goose down to 66: %v", err)
	}
	if indexExists(t, db, "idx_intake_log_tz_plan_step_unique") {
		t.Fatal("index should not exist after down to 66")
	}

	if err := goose.UpToContext(ctx, db, "migrations", 67); err != nil {
		t.Fatalf("goose re-up to 67: %v", err)
	}
	if !indexExists(t, db, "idx_intake_log_tz_plan_step_unique") {
		t.Fatal("index missing after re-up")
	}
}
