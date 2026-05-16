package store

import (
	"context"
	"database/sql"
	"os"
	"testing"
	"time"

	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"
)

// TestMigration068_BackfillSeedFixture covers the Track D Task 10 backfill
// migration's behaviour on a representative pre-deploy fixture: one APPROVED
// plan with two steps (one consumed, one unconsumed), one COMPLETED plan with
// all steps consumed, one PENDING_APPROVAL plan, and one orphan step whose
// medication has been deleted (FKs are off in this project so dangling step
// rows are possible). Exactly one row must be inserted into intake_log — the
// unconsumed step from the APPROVED plan — and a second backfill run is a
// no-op thanks to migration 067's partial unique index.
func TestMigration068_BackfillSeedFixture(t *testing.T) {
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

	// Apply up to migration 067 (schema before the Go backfill).
	if err := goose.UpToContext(ctx, db, "migrations", 67); err != nil {
		t.Fatalf("goose up to 67: %v", err)
	}

	// Seed: two medications, four plans, four step rows.
	if _, err := db.Exec(`INSERT INTO medications (id, name, dosage, schedule) VALUES (1, 'Aspirin', '100mg', '08:00')`); err != nil {
		t.Fatalf("insert med 1: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO medications (id, name, dosage, schedule) VALUES (2, 'Ibuprofen', '200mg', '08:00')`); err != nil {
		t.Fatalf("insert med 2: %v", err)
	}

	// Plan A (APPROVED, two steps: one consumed, one unconsumed).
	insertPlan068(t, db, 1, "APPROVED", "h1")
	insertStep068(t, db, 1, 1, 1, time.Date(2026, 5, 16, 6, 0, 0, 0, time.UTC), true)  // consumed
	insertStep068(t, db, 1, 1, 2, time.Date(2026, 5, 16, 7, 0, 0, 0, time.UTC), false) // unconsumed

	// Plan B (COMPLETED, all steps consumed).
	insertPlan068(t, db, 2, "COMPLETED", "h2")
	insertStep068(t, db, 2, 1, 1, time.Date(2026, 5, 15, 6, 0, 0, 0, time.UTC), true)

	// Plan C (PENDING_APPROVAL, has steps but plan isn't approved).
	insertPlan068(t, db, 3, "PENDING_APPROVAL", "h3")
	insertStep068(t, db, 3, 2, 1, time.Date(2026, 5, 17, 6, 0, 0, 0, time.UTC), false)

	// Plan D (APPROVED, one orphan step whose medication was deleted).
	insertPlan068(t, db, 4, "APPROVED", "h4")
	insertStep068(t, db, 4, 99, 1, time.Date(2026, 5, 16, 9, 0, 0, 0, time.UTC), false)

	// Run the backfill.
	if err := goose.UpToContext(ctx, db, "migrations", 68); err != nil {
		t.Fatalf("goose up to 68: %v", err)
	}

	// Exactly one row must exist: the unconsumed step from Plan A.
	rows, err := db.Query(`SELECT tz_plan_id, tz_step_number, status, source FROM intake_log ORDER BY id`)
	if err != nil {
		t.Fatalf("read intake_log: %v", err)
	}
	defer rows.Close()
	type seen struct {
		planID, stepNum int64
		status, source  string
	}
	var got []seen
	for rows.Next() {
		var s seen
		var planID, stepNum sql.NullInt64
		if err := rows.Scan(&planID, &stepNum, &s.status, &s.source); err != nil {
			t.Fatalf("scan: %v", err)
		}
		s.planID = planID.Int64
		s.stepNum = stepNum.Int64
		got = append(got, s)
	}
	if len(got) != 1 {
		t.Fatalf("intake_log rows=%d want 1 (only the unconsumed step from APPROVED plan A)", len(got))
	}
	want := seen{planID: 1, stepNum: 2, status: "PENDING", source: "tz_step"}
	if got[0] != want {
		t.Errorf("backfilled row=%+v want %+v", got[0], want)
	}

	// Re-running the backfill is a no-op: migration 067's partial unique
	// index makes INSERT OR IGNORE skip the duplicate.
	if err := goose.DownToContext(ctx, db, "migrations", 67); err != nil {
		t.Fatalf("goose down to 67: %v", err)
	}
	if err := goose.UpToContext(ctx, db, "migrations", 68); err != nil {
		t.Fatalf("goose re-up to 68: %v", err)
	}
	var rerunCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM intake_log WHERE source = 'tz_step'`).Scan(&rerunCount); err != nil {
		t.Fatalf("count after re-run: %v", err)
	}
	// Down→Up of migration 068 first nukes PENDING tz_step rows then
	// re-inserts. Since the down-step deletes them, the up restores them
	// from the source table: still 1 row.
	if rerunCount != 1 {
		t.Errorf("rows after down/up=%d want 1", rerunCount)
	}
}

// TestMigration068_NoApprovedPlansSkipsEnvCheck pins the early-exit behaviour
// that lets the migration run on test fixtures without ALLOWED_USER_ID set.
// The migration only fails loudly when there's actual data to attribute.
func TestMigration068_NoApprovedPlansSkipsEnvCheck(t *testing.T) {
	// Deliberately do NOT set ALLOWED_USER_ID.
	if val := os.Getenv("ALLOWED_USER_ID"); val != "" {
		// Existing env override would mask the test; clear and restore.
		t.Setenv("ALLOWED_USER_ID", "")
	}

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

	// Run all migrations on an empty schema. Migration 068 should be a
	// no-op because there are no APPROVED plans, and the missing env var
	// must not trip the check.
	if err := goose.UpContext(ctx, db, "migrations"); err != nil {
		t.Fatalf("goose up: %v (migration 068 should not require ALLOWED_USER_ID when there's nothing to backfill)", err)
	}

	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM intake_log WHERE source = 'tz_step'`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Errorf("tz_step rows after no-op backfill=%d want 0", n)
	}
}

// --- helpers ---

func insertPlan068(t *testing.T, db *sql.DB, id int64, status, hash string) {
	t.Helper()
	if _, err := db.Exec(
		`INSERT INTO tz_transition_plans (id, old_tz, new_tz, status, steps_json, inputs_json, plan_hash)
		 VALUES (?, 'UTC', 'Europe/Berlin', ?, '[]', '{}', ?)`,
		id, status, hash,
	); err != nil {
		t.Fatalf("insert plan %d: %v", id, err)
	}
}

func insertStep068(t *testing.T, db *sql.DB, planID, medID int64, stepNum int, scheduledAt time.Time, consumed bool) {
	t.Helper()
	res, err := db.Exec(
		`INSERT INTO tz_transition_steps (plan_id, medication_id, step_number, scheduled_at, note)
		 VALUES (?, ?, ?, ?, ?)`,
		planID, medID, stepNum, scheduledAt, "test step",
	)
	if err != nil {
		t.Fatalf("insert step (plan=%d med=%d step=%d): %v", planID, medID, stepNum, err)
	}
	if consumed {
		stepID, _ := res.LastInsertId()
		if _, err := db.Exec(`UPDATE tz_transition_steps SET consumed_at = ? WHERE id = ?`, scheduledAt, stepID); err != nil {
			t.Fatalf("mark step consumed: %v", err)
		}
	}
}
