package store

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"
)

// TestMigration069_DropsTZTransitionStepsTable covers Track D Task 13: the
// tz_transition_steps table is dropped. Pre-materialized intake_log rows
// (source='tz_step', written at approve time) are the only remaining record
// of a plan's per-dose steps, and their data is unaffected by the migration.
func TestMigration069_DropsTZTransitionStepsTable(t *testing.T) {
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

	// Apply up to migration 068 (last revision before the drop). The schema
	// must still know about tz_transition_steps so we can seed it.
	if err := goose.UpToContext(ctx, db, "migrations", 68); err != nil {
		t.Fatalf("goose up to 68: %v", err)
	}

	if !tableExists(t, db, "tz_transition_steps") {
		t.Fatal("tz_transition_steps should exist at migration 068")
	}

	// Seed a plan with one pre-materialized intake row so we can prove the
	// drop preserves intake_log data even though it nukes the step table.
	if _, err := db.Exec(`INSERT INTO medications (id, name, dosage, schedule) VALUES (1, 'Aspirin', '100mg', '08:00')`); err != nil {
		t.Fatalf("insert medication: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO tz_transition_plans (id, old_tz, new_tz, status, steps_json, inputs_json, plan_hash)
		 VALUES (7, 'UTC', 'Europe/Berlin', 'APPROVED', '[{"MedicationID":1,"StepNumber":1,"ScheduledAt":"2026-05-16T06:00:00Z"}]', '{}', 'h069')`,
	); err != nil {
		t.Fatalf("insert plan: %v", err)
	}
	stepUnix := time.Date(2026, 5, 16, 6, 0, 0, 0, time.UTC).Unix()
	if _, err := db.Exec(
		`INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, status, source, tz_plan_id, tz_step_number)
		 VALUES (1, 42, ?, 'PENDING', 'tz_step', 7, 1)`,
		stepUnix,
	); err != nil {
		t.Fatalf("insert intake_log: %v", err)
	}

	// Run the drop.
	if err := goose.UpToContext(ctx, db, "migrations", 69); err != nil {
		t.Fatalf("goose up to 69: %v", err)
	}

	if tableExists(t, db, "tz_transition_steps") {
		t.Error("tz_transition_steps should not exist after migration 069")
	}

	// The intake_log row (the survivor of the pre-materialized step) must be
	// untouched.
	var rowCount int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM intake_log WHERE tz_plan_id = 7 AND source = 'tz_step'`,
	).Scan(&rowCount); err != nil {
		t.Fatalf("count intake_log: %v", err)
	}
	if rowCount != 1 {
		t.Errorf("expected 1 pre-materialized intake row to survive migration 069, got %d", rowCount)
	}

	// The plan's steps_json — the new source of truth — must also be intact.
	var stepsJSON string
	if err := db.QueryRow(`SELECT steps_json FROM tz_transition_plans WHERE id = 7`).Scan(&stepsJSON); err != nil {
		t.Fatalf("read steps_json: %v", err)
	}
	if stepsJSON == "" || stepsJSON == "[]" {
		t.Errorf("steps_json lost on migration 069: %q", stepsJSON)
	}
}

// TestMigration069_RoundTrip exercises goose Up → Down → Up across migration
// 069. After down the table must reappear (empty), after re-up it must be
// gone again. The migration's down-step is best-effort (rows cannot be
// recovered), so we only verify the schema shape round-trips.
func TestMigration069_RoundTrip(t *testing.T) {
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

	if err := goose.UpToContext(ctx, db, "migrations", 69); err != nil {
		t.Fatalf("goose up to 69: %v", err)
	}
	if tableExists(t, db, "tz_transition_steps") {
		t.Fatal("tz_transition_steps should not exist after first up")
	}

	if err := goose.DownToContext(ctx, db, "migrations", 68); err != nil {
		t.Fatalf("goose down to 68: %v", err)
	}
	if !tableExists(t, db, "tz_transition_steps") {
		t.Fatal("tz_transition_steps should be recreated after down to 68")
	}

	if err := goose.UpToContext(ctx, db, "migrations", 69); err != nil {
		t.Fatalf("goose re-up to 69: %v", err)
	}
	if tableExists(t, db, "tz_transition_steps") {
		t.Fatal("tz_transition_steps should be gone after re-up")
	}
}

func tableExists(t *testing.T, db *sql.DB, name string) bool {
	t.Helper()
	var n int
	err := db.QueryRow(
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, name,
	).Scan(&n)
	if err != nil {
		t.Fatalf("check table %s: %v", name, err)
	}
	return n > 0
}
