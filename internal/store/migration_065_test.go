package store

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"
)

// TestMigration065_DropsLegacyDateTimesAndPreservesData exercises Task 7's
// table-rebuild that removes the legacy tz_transition_plans.{created_at,
// notified_at, approved_at} DATETIME columns. We seed a populated fixture, run
// goose up to 65, and assert that:
//
//   - the three legacy columns are gone
//   - the *_unix columns survive with the same values (NULL stays NULL)
//   - id values are preserved (so tz_transition_steps.plan_id remains valid)
//   - the partial unique index idx_tz_plans_hash_active still exists
//   - the new idx_tz_plans_created_at_unix index is present
func TestMigration065_DropsLegacyDateTimesAndPreservesData(t *testing.T) {
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

	// Migrate up to 64 so we can populate both the legacy DATETIME and the
	// new *_unix columns — matches the dual-write state during development.
	if err := goose.UpToContext(ctx, db, "migrations", 64); err != nil {
		t.Fatalf("goose up to 64: %v", err)
	}

	la, _ := time.LoadLocation("America/Los_Angeles")
	berlin, _ := time.LoadLocation("Europe/Berlin")

	type seed struct {
		id          int64
		createdUnix int64
		notifiedU   sql.NullInt64
		approvedU   sql.NullInt64
		status      string
		hash        string
	}
	var seeds []seed

	for i := 0; i < 25; i++ {
		var loc *time.Location
		if i%2 == 0 {
			loc = la
		} else {
			loc = berlin
		}
		created := time.Date(2026, 5, 10, i%24, 0, 0, 0, loc).Add(time.Duration(i) * time.Hour)
		createdUnix := created.UTC().Unix()
		var notifiedAt interface{}
		var approvedAt interface{}
		var notifiedUnix sql.NullInt64
		var approvedUnix sql.NullInt64
		status := "PENDING_APPROVAL"
		// Pick a status mix to ensure distinct plan_hashes don't collide on
		// the partial unique index (it excludes terminal statuses).
		if i%5 == 1 {
			n := created.Add(5 * time.Minute)
			notifiedAt = n
			notifiedUnix = sql.NullInt64{Int64: n.UTC().Unix(), Valid: true}
			status = "NOTIFIED"
		}
		if i%5 == 2 {
			n := created.Add(5 * time.Minute)
			a := created.Add(15 * time.Minute)
			notifiedAt = n
			approvedAt = a
			notifiedUnix = sql.NullInt64{Int64: n.UTC().Unix(), Valid: true}
			approvedUnix = sql.NullInt64{Int64: a.UTC().Unix(), Valid: true}
			status = "APPROVED"
		}
		if i%5 == 3 {
			status = "REJECTED"
		}
		if i%5 == 4 {
			status = "COMPLETED"
		}
		hash := "h-" + status + "-" + time.Duration(i).String()
		res, err := db.Exec(
			`INSERT INTO tz_transition_plans
				(old_tz, new_tz, status, steps_json, inputs_json, plan_hash,
				 created_at, notified_at, approved_at,
				 created_at_unix, notified_at_unix, approved_at_unix)
			 VALUES (?, ?, ?, '[]', '{}', ?, ?, ?, ?, ?, ?, ?)`,
			"UTC", "Europe/Berlin", status, hash,
			created, notifiedAt, approvedAt,
			createdUnix,
			func() interface{} {
				if notifiedUnix.Valid {
					return notifiedUnix.Int64
				}
				return nil
			}(),
			func() interface{} {
				if approvedUnix.Valid {
					return approvedUnix.Int64
				}
				return nil
			}(),
		)
		if err != nil {
			t.Fatalf("seed insert %d: %v", i, err)
		}
		id, err := res.LastInsertId()
		if err != nil {
			t.Fatalf("LastInsertId %d: %v", i, err)
		}
		seeds = append(seeds, seed{
			id: id, createdUnix: createdUnix,
			notifiedU: notifiedUnix, approvedU: approvedUnix,
			status: status, hash: hash,
		})
	}

	// Apply migration 065 — table rebuild that drops the DATETIME columns.
	if err := goose.UpToContext(ctx, db, "migrations", 65); err != nil {
		t.Fatalf("goose up to 65: %v", err)
	}

	// Legacy columns must be gone.
	if columnExists(t, db, "tz_transition_plans", "created_at") {
		t.Errorf("created_at column should be dropped after migration 065")
	}
	if columnExists(t, db, "tz_transition_plans", "notified_at") {
		t.Errorf("notified_at column should be dropped after migration 065")
	}
	if columnExists(t, db, "tz_transition_plans", "approved_at") {
		t.Errorf("approved_at column should be dropped after migration 065")
	}
	// New columns must remain.
	if !columnExists(t, db, "tz_transition_plans", "created_at_unix") {
		t.Errorf("created_at_unix should remain after migration 065")
	}
	if !columnExists(t, db, "tz_transition_plans", "notified_at_unix") {
		t.Errorf("notified_at_unix should remain after migration 065")
	}
	if !columnExists(t, db, "tz_transition_plans", "approved_at_unix") {
		t.Errorf("approved_at_unix should remain after migration 065")
	}

	// Indexes must be present.
	if !indexExists(t, db, "idx_tz_plans_hash_active") {
		t.Errorf("idx_tz_plans_hash_active should still exist after rebuild")
	}
	if !indexExists(t, db, "idx_tz_plans_created_at_unix") {
		t.Errorf("idx_tz_plans_created_at_unix should still exist after rebuild")
	}

	// Verify all rows survived with the same id and unix values.
	type got struct {
		createdAt int64
		notifiedU sql.NullInt64
		approvedU sql.NullInt64
		status    string
	}
	gotByID := map[int64]got{}
	rows, err := db.Query("SELECT id, created_at_unix, notified_at_unix, approved_at_unix, status FROM tz_transition_plans ORDER BY id ASC")
	if err != nil {
		t.Fatalf("query after up: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, c int64
		var n, a sql.NullInt64
		var s string
		if err := rows.Scan(&id, &c, &n, &a, &s); err != nil {
			t.Fatalf("scan: %v", err)
		}
		gotByID[id] = got{createdAt: c, notifiedU: n, approvedU: a, status: s}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows err: %v", err)
	}

	for _, s := range seeds {
		g, ok := gotByID[s.id]
		if !ok {
			t.Errorf("seed id=%d missing after rebuild", s.id)
			continue
		}
		if g.createdAt != s.createdUnix {
			t.Errorf("id=%d: created_at_unix=%d want %d", s.id, g.createdAt, s.createdUnix)
		}
		if g.notifiedU.Valid != s.notifiedU.Valid || g.notifiedU.Int64 != s.notifiedU.Int64 {
			t.Errorf("id=%d: notified_at_unix=%v want %v", s.id, g.notifiedU, s.notifiedU)
		}
		if g.approvedU.Valid != s.approvedU.Valid || g.approvedU.Int64 != s.approvedU.Int64 {
			t.Errorf("id=%d: approved_at_unix=%v want %v", s.id, g.approvedU, s.approvedU)
		}
		if g.status != s.status {
			t.Errorf("id=%d: status=%q want %q", s.id, g.status, s.status)
		}
	}
}

// TestMigration065_RoundTrip exercises Up → Down → Up on a small fixture.
// The Down step is intentionally lossy (DATETIME reconstructed as UTC text
// via datetime(N,'unixepoch')); we only assert that the *_unix column values
// stay correct, not that the original TZ-named strings are recovered.
func TestMigration065_RoundTrip(t *testing.T) {
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

	if err := goose.UpToContext(ctx, db, "migrations", 65); err != nil {
		t.Fatalf("goose up to 65: %v", err)
	}

	created := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC).Unix()
	notified := created + 300
	approved := created + 900

	res, err := db.Exec(
		`INSERT INTO tz_transition_plans
			(old_tz, new_tz, status, steps_json, inputs_json, plan_hash,
			 created_at_unix, notified_at_unix, approved_at_unix)
		 VALUES (?, ?, ?, '[]', '{}', ?, ?, ?, ?)`,
		"UTC", "Europe/Berlin", "APPROVED", "rt-hash-65", created, notified, approved,
	)
	if err != nil {
		t.Fatalf("seed insert: %v", err)
	}
	id, _ := res.LastInsertId()

	// Down to 64 — legacy DATETIME columns return, *_unix survive.
	if err := goose.DownToContext(ctx, db, "migrations", 64); err != nil {
		t.Fatalf("goose down to 64: %v", err)
	}
	if !columnExists(t, db, "tz_transition_plans", "created_at") {
		t.Errorf("created_at should reappear after Down")
	}
	if !columnExists(t, db, "tz_transition_plans", "created_at_unix") {
		t.Errorf("created_at_unix should remain after Down")
	}
	var c sql.NullInt64
	if err := db.QueryRow("SELECT created_at_unix FROM tz_transition_plans WHERE id=?", id).Scan(&c); err != nil {
		t.Fatalf("read after down: %v", err)
	}
	if !c.Valid || c.Int64 != created {
		t.Errorf("after down: created_at_unix=%v want %d", c, created)
	}

	// Up again — DATETIME columns drop.
	if err := goose.UpToContext(ctx, db, "migrations", 65); err != nil {
		t.Fatalf("goose up to 65 (second time): %v", err)
	}
	if columnExists(t, db, "tz_transition_plans", "created_at") {
		t.Errorf("created_at should be dropped after re-up")
	}
	var c2 int64
	var n2, a2 sql.NullInt64
	if err := db.QueryRow("SELECT created_at_unix, notified_at_unix, approved_at_unix FROM tz_transition_plans WHERE id=?", id).Scan(&c2, &n2, &a2); err != nil {
		t.Fatalf("read after re-up: %v", err)
	}
	if c2 != created {
		t.Errorf("after re-up: created_at_unix=%d want %d", c2, created)
	}
	if !n2.Valid || n2.Int64 != notified {
		t.Errorf("after re-up: notified_at_unix=%v want %d", n2, notified)
	}
	if !a2.Valid || a2.Int64 != approved {
		t.Errorf("after re-up: approved_at_unix=%v want %d", a2, approved)
	}
}

