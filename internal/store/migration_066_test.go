package store

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"
)

// TestMigration066_AddsSourceAndTZPlanColumns exercises Task 9 of the
// scheduler-simplification plan: migration 066 opens three new columns on
// intake_log (source / tz_plan_id / tz_step_number) and an
// idx_intake_log_tz_plan_id index. Pre-existing rows must get
// source='schedule' via the column default; tz_plan_id / tz_step_number stay
// NULL.
func TestMigration066_AddsSourceAndTZPlanColumns(t *testing.T) {
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

	// Apply up to migration 065 — schema before Task 9's column adds.
	if err := goose.UpToContext(ctx, db, "migrations", 65); err != nil {
		t.Fatalf("goose up to 65: %v", err)
	}

	// Seed an existing intake row so we can assert the default backfills it
	// to source='schedule'. The schema-65 intake_log doesn't have source yet.
	sched := time.Date(2026, 5, 16, 8, 0, 0, 0, time.UTC).Unix()
	res, err := db.Exec(
		"INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, status) VALUES (?, ?, ?, 'PENDING')",
		int64(1), int64(1), sched,
	)
	if err != nil {
		t.Fatalf("seed insert: %v", err)
	}
	seedID, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("LastInsertId: %v", err)
	}

	// Apply migration 066.
	if err := goose.UpToContext(ctx, db, "migrations", 66); err != nil {
		t.Fatalf("goose up to 66: %v", err)
	}

	// All three columns must now exist.
	for _, col := range []string{"source", "tz_plan_id", "tz_step_number"} {
		if !columnExists(t, db, "intake_log", col) {
			t.Errorf("column %s should exist after migration 066", col)
		}
	}

	// Index must exist.
	if !indexExists(t, db, "idx_intake_log_tz_plan_id") {
		t.Errorf("idx_intake_log_tz_plan_id should exist after migration 066")
	}

	// Existing row got the default source='schedule'; tz_plan_id /
	// tz_step_number stay NULL.
	var source string
	var planID, stepNum sql.NullInt64
	if err := db.QueryRow(
		"SELECT source, tz_plan_id, tz_step_number FROM intake_log WHERE id = ?", seedID,
	).Scan(&source, &planID, &stepNum); err != nil {
		t.Fatalf("read columns: %v", err)
	}
	if source != "schedule" {
		t.Errorf("source=%q, want %q (column default)", source, "schedule")
	}
	if planID.Valid {
		t.Errorf("tz_plan_id should be NULL, got %d", planID.Int64)
	}
	if stepNum.Valid {
		t.Errorf("tz_step_number should be NULL, got %d", stepNum.Int64)
	}
}

// TestMigration066_RoundTrip exercises goose Up → Down → Up across migration
// 066 against a populated fixture and asserts the column / index lifecycle.
func TestMigration066_RoundTrip(t *testing.T) {
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

	if err := goose.UpToContext(ctx, db, "migrations", 66); err != nil {
		t.Fatalf("goose up to 66: %v", err)
	}

	// Insert one row carrying values for every new column.
	sched := time.Date(2026, 5, 16, 8, 0, 0, 0, time.UTC).Unix()
	res, err := db.Exec(
		`INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, status, source, tz_plan_id, tz_step_number)
		 VALUES (?, ?, ?, 'PENDING', 'tz_step', ?, ?)`,
		int64(1), int64(1), sched, int64(42), int64(3),
	)
	if err != nil {
		t.Fatalf("seed insert: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("LastInsertId: %v", err)
	}

	var source string
	var planID, stepNum sql.NullInt64
	if err := db.QueryRow("SELECT source, tz_plan_id, tz_step_number FROM intake_log WHERE id = ?", id).Scan(&source, &planID, &stepNum); err != nil {
		t.Fatalf("read after up: %v", err)
	}
	if source != "tz_step" {
		t.Errorf("source=%q want %q", source, "tz_step")
	}
	if !planID.Valid || planID.Int64 != 42 {
		t.Errorf("tz_plan_id=%v want 42", planID)
	}
	if !stepNum.Valid || stepNum.Int64 != 3 {
		t.Errorf("tz_step_number=%v want 3", stepNum)
	}

	// Down to 65 — all three columns + index must vanish.
	if err := goose.DownToContext(ctx, db, "migrations", 65); err != nil {
		t.Fatalf("goose down to 65: %v", err)
	}
	for _, col := range []string{"source", "tz_plan_id", "tz_step_number"} {
		if columnExists(t, db, "intake_log", col) {
			t.Errorf("column %s should be dropped after Down", col)
		}
	}
	if indexExists(t, db, "idx_intake_log_tz_plan_id") {
		t.Errorf("idx_intake_log_tz_plan_id should be dropped after Down")
	}

	// Up again — columns + index reappear; pre-existing row gets default source.
	if err := goose.UpToContext(ctx, db, "migrations", 66); err != nil {
		t.Fatalf("goose up to 66 (second time): %v", err)
	}
	var source2 string
	var planID2, stepNum2 sql.NullInt64
	if err := db.QueryRow("SELECT source, tz_plan_id, tz_step_number FROM intake_log WHERE id = ?", id).Scan(&source2, &planID2, &stepNum2); err != nil {
		t.Fatalf("read after re-up: %v", err)
	}
	if source2 != "schedule" {
		t.Errorf("after re-up: source=%q want %q (column default applies — Down lost the tz_step row)", source2, "schedule")
	}
	if planID2.Valid {
		t.Errorf("after re-up: tz_plan_id should be NULL, got %d", planID2.Int64)
	}
	if stepNum2.Valid {
		t.Errorf("after re-up: tz_step_number should be NULL, got %d", stepNum2.Int64)
	}
}
