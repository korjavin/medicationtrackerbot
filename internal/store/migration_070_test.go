package store

import (
	"context"
	"database/sql"
	"strings"
	"testing"

	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"
)

// TestMigration070_UniqueIndexAllowsSameStepNumberPerMed covers the
// post-review fix: the unique index now scopes by medication_id so two
// medications inside the same plan can both have step_number=1 (the natural
// output of tzreschedule.GeneratePlan, which numbers steps per-medication).
// Without medication_id in the key, INSERT OR IGNORE silently dropped every
// med after the first.
func TestMigration070_UniqueIndexAllowsSameStepNumberPerMed(t *testing.T) {
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

	if !indexExists(t, db, "idx_intake_log_tz_plan_step_unique") {
		t.Fatal("idx_intake_log_tz_plan_step_unique should exist after migration 070")
	}

	if _, err := db.Exec(
		`INSERT INTO medications (id, name, dosage, schedule) VALUES (1, 'A', '10mg', '08:00'), (2, 'B', '20mg', '08:00')`,
	); err != nil {
		t.Fatalf("insert medications: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO tz_transition_plans (id, old_tz, new_tz, status, steps_json, inputs_json, plan_hash)
		 VALUES (1, 'UTC', 'Europe/Berlin', 'APPROVED', '[]', '{}', 'h1')`,
	); err != nil {
		t.Fatalf("insert plan: %v", err)
	}

	// Two different meds, same step_number=1 inside the same plan: must succeed.
	if _, err := db.Exec(
		`INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, status, source, tz_plan_id, tz_step_number)
		 VALUES (1, 1, 1000, 'PENDING', 'tz_step', 1, 1)`,
	); err != nil {
		t.Fatalf("medA step 1: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, status, source, tz_plan_id, tz_step_number)
		 VALUES (2, 1, 1100, 'PENDING', 'tz_step', 1, 1)`,
	); err != nil {
		t.Errorf("medB step 1 should succeed (different medication_id): %v", err)
	}

	// Same med, same plan, same step_number: still a duplicate — must fail.
	if _, err := db.Exec(
		`INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, status, source, tz_plan_id, tz_step_number)
		 VALUES (1, 1, 2000, 'PENDING', 'tz_step', 1, 1)`,
	); err == nil {
		t.Error("duplicate (plan, med, step) insert should violate unique index, got nil error")
	} else if !strings.Contains(err.Error(), "UNIQUE constraint failed") {
		t.Errorf("expected UNIQUE constraint error, got: %v", err)
	}

	// INSERT OR IGNORE on the same duplicate is silent.
	if _, err := db.Exec(
		`INSERT OR IGNORE INTO intake_log (medication_id, user_id, scheduled_at_unix, status, source, tz_plan_id, tz_step_number)
		 VALUES (1, 1, 3000, 'PENDING', 'tz_step', 1, 1)`,
	); err != nil {
		t.Errorf("INSERT OR IGNORE should not error on duplicate: %v", err)
	}

	// Normal source='schedule' rows with NULL tz_plan_id are still unconstrained.
	if _, err := db.Exec(
		`INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, status, source) VALUES (1, 1, 4000, 'PENDING', 'schedule')`,
	); err != nil {
		t.Fatalf("schedule row 1: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, status, source) VALUES (1, 1, 5000, 'PENDING', 'schedule')`,
	); err != nil {
		t.Errorf("schedule row 2 should succeed (partial index excludes NULL tz_plan_id): %v", err)
	}
}

// TestMigration070_RoundTrip exercises goose Up → Down → Up across migration
// 070. The legacy two-column index from 067 reappears on Down so test
// fixtures that only run up to 67/68/69 still observe its shape.
func TestMigration070_RoundTrip(t *testing.T) {
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
	if !indexExists(t, db, "idx_intake_log_tz_plan_step_unique") {
		t.Fatal("index missing after first up")
	}

	if err := goose.DownToContext(ctx, db, "migrations", 69); err != nil {
		t.Fatalf("goose down to 69: %v", err)
	}
	if !indexExists(t, db, "idx_intake_log_tz_plan_step_unique") {
		t.Fatal("Down should re-create the legacy 067-shape index, not delete it")
	}

	if err := goose.UpToContext(ctx, db, "migrations", 70); err != nil {
		t.Fatalf("goose re-up to 70: %v", err)
	}
	if !indexExists(t, db, "idx_intake_log_tz_plan_step_unique") {
		t.Fatal("index missing after re-up")
	}
}
