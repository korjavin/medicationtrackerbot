package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"
)

// TestMigration064_BackfillsProductionTZPlanTimeFormats pins the Task 7
// backfill assumption: every datetime string format observed in production for
// the tz_transition_plans.{created_at,notified_at,approved_at} columns (the
// same set as intake_log's three time columns — `PDT`, `MST`, `CEST`, `UTC`,
// RFC3339, and the monotonic-clock-residue variant) is parseable by SQLite's
// strftime path (direct or via the substr-reformat fallback) and produces the
// same unix seconds as the producing time.Time's t.Unix().
func TestMigration064_BackfillsProductionTZPlanTimeFormats(t *testing.T) {
	berlin, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatalf("load Europe/Berlin: %v", err)
	}
	la, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatalf("load America/Los_Angeles: %v", err)
	}
	phoenix, err := time.LoadLocation("America/Phoenix")
	if err != nil {
		t.Fatalf("load America/Phoenix: %v", err)
	}

	cases := []struct {
		name string
		t    time.Time
	}{
		{"CEST", time.Date(2026, 5, 10, 17, 20, 0, 0, berlin)},
		{"CET", time.Date(2026, 1, 15, 18, 20, 0, 0, berlin)},
		{"PDT", time.Date(2026, 5, 10, 8, 20, 0, 0, la)},
		{"MST", time.Date(2026, 5, 10, 8, 20, 0, 0, phoenix)},
		{"UTC", time.Date(2026, 5, 10, 15, 20, 0, 0, time.UTC)},
		{"PST", time.Date(2026, 1, 15, 9, 0, 0, 0, la)},
		{"CEST.frac", time.Date(2026, 5, 10, 17, 20, 0, 123456789, berlin)},
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

	// Apply migrations up to 063 — schema with tz_transition_plans carrying the
	// legacy DATETIME columns but no *_unix columns yet.
	if err := goose.UpToContext(ctx, db, "migrations", 63); err != nil {
		t.Fatalf("goose up to 63: %v", err)
	}

	// Insert one row per format. modernc.org/sqlite serializes the bound
	// time.Time via t.String() — the same code path that produced prod values.
	caseIDs := make([]int64, len(cases))
	for i, c := range cases {
		res, err := db.Exec(
			`INSERT INTO tz_transition_plans (old_tz, new_tz, status, steps_json, inputs_json, plan_hash, created_at, notified_at, approved_at)
			 VALUES (?, ?, ?, '[]', '{}', ?, ?, ?, ?)`,
			"UTC", "Europe/Berlin", "APPROVED", "hash-"+c.name, c.t, c.t, c.t,
		)
		if err != nil {
			t.Fatalf("insert row for %s: %v", c.name, err)
		}
		id, err := res.LastInsertId()
		if err != nil {
			t.Fatalf("LastInsertId for %s: %v", c.name, err)
		}
		caseIDs[i] = id
	}

	// Row with NULL notified_at + approved_at — must remain NULL after backfill.
	nullCreatedAt := time.Date(2026, 5, 10, 9, 0, 0, 0, time.UTC)
	res, err := db.Exec(
		`INSERT INTO tz_transition_plans (old_tz, new_tz, status, steps_json, inputs_json, plan_hash, created_at, notified_at, approved_at)
		 VALUES (?, ?, ?, '[]', '{}', ?, ?, NULL, NULL)`,
		"UTC", "Europe/Berlin", "PENDING_APPROVAL", "hash-null", nullCreatedAt,
	)
	if err != nil {
		t.Fatalf("insert null row: %v", err)
	}
	nullID, _ := res.LastInsertId()

	// RFC3339 Z variant (newer driver formats).
	rfcRow := time.Date(2026, 5, 10, 15, 20, 0, 0, time.UTC)
	rfcZID := insertTZPlanRaw(t, db, "2026-05-10T15:20:00Z", "2026-05-10T15:20:00Z", "2026-05-10T15:20:00Z", "hash-rfcz")
	// CURRENT_TIMESTAMP format (space-separated UTC).
	tsID := insertTZPlanRaw(t, db, "2026-05-10 15:20:00", "2026-05-10 15:20:00", "2026-05-10 15:20:00", "hash-ts")
	// Monotonic-clock residue: t.String() may leak " m=+201.247835759" onto the end.
	monotonicID := insertTZPlanRaw(t, db,
		"2026-05-10 17:20:00 +0200 CEST m=+201.247835759",
		"2026-05-10 17:20:00 +0200 CEST m=+201.247835759",
		"2026-05-10 17:20:00 +0200 CEST m=+201.247835759",
		"hash-mono")

	// Apply migration 064 against the populated fixture.
	applyMigration(t, db, filepath.Join("migrations", "064_add_tz_transition_plans_unix.sql"))

	// Read back every row and assert *_at_unix == t.Unix() for the
	// time-bound rows and that the NULL row stays NULL where expected.
	type got struct {
		createdAt  int64
		notifiedAt sql.NullInt64
		approvedAt sql.NullInt64
	}
	gotByID := map[int64]got{}
	rows, err := db.Query("SELECT id, created_at_unix, notified_at_unix, approved_at_unix FROM tz_transition_plans ORDER BY id ASC")
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var c int64
		var n sql.NullInt64
		var a sql.NullInt64
		if err := rows.Scan(&id, &c, &n, &a); err != nil {
			t.Fatalf("scan: %v", err)
		}
		gotByID[id] = got{createdAt: c, notifiedAt: n, approvedAt: a}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows err: %v", err)
	}

	for i, c := range cases {
		id := caseIDs[i]
		want := c.t.Unix()
		g, ok := gotByID[id]
		if !ok {
			t.Fatalf("row id=%d (%s) not found after backfill", id, c.name)
		}
		if g.createdAt != want {
			t.Errorf("%s: created_at_unix=%d want %d (input.String()=%q)",
				c.name, g.createdAt, want, c.t.String())
		}
		if !g.notifiedAt.Valid || g.notifiedAt.Int64 != want {
			t.Errorf("%s: notified_at_unix=%v want %d", c.name, g.notifiedAt, want)
		}
		if !g.approvedAt.Valid || g.approvedAt.Int64 != want {
			t.Errorf("%s: approved_at_unix=%v want %d", c.name, g.approvedAt, want)
		}
	}

	wantNull := nullCreatedAt.Unix()
	g, ok := gotByID[nullID]
	if !ok {
		t.Fatalf("null row missing")
	}
	if g.createdAt != wantNull {
		t.Errorf("null row created_at_unix=%d want %d", g.createdAt, wantNull)
	}
	if g.notifiedAt.Valid {
		t.Errorf("null row notified_at_unix should be NULL, got %d", g.notifiedAt.Int64)
	}
	if g.approvedAt.Valid {
		t.Errorf("null row approved_at_unix should be NULL, got %d", g.approvedAt.Int64)
	}

	wantRFC := rfcRow.Unix()
	for _, id := range []int64{rfcZID, tsID, monotonicID} {
		g, ok := gotByID[id]
		if !ok {
			t.Fatalf("row id=%d not found", id)
		}
		if g.createdAt != wantRFC {
			t.Errorf("row id=%d: created_at_unix=%d want %d", id, g.createdAt, wantRFC)
		}
		if !g.notifiedAt.Valid || g.notifiedAt.Int64 != wantRFC {
			t.Errorf("row id=%d: notified_at_unix=%v want %d", id, g.notifiedAt, wantRFC)
		}
		if !g.approvedAt.Valid || g.approvedAt.Int64 != wantRFC {
			t.Errorf("row id=%d: approved_at_unix=%v want %d", id, g.approvedAt, wantRFC)
		}
	}
}

func insertTZPlanRaw(t *testing.T, db *sql.DB, createdAt, notifiedAt, approvedAt, hash string) int64 {
	t.Helper()
	res, err := db.Exec(
		`INSERT INTO tz_transition_plans (old_tz, new_tz, status, steps_json, inputs_json, plan_hash, created_at, notified_at, approved_at)
		 VALUES (?, ?, ?, '[]', '{}', ?, ?, ?, ?)`,
		"UTC", "Europe/Berlin", "APPROVED", hash, createdAt, notifiedAt, approvedAt,
	)
	if err != nil {
		t.Fatalf("insert raw row hash=%s: %v", hash, err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("LastInsertId: %v", err)
	}
	return id
}

// TestMigration064_RoundTrip exercises goose Up → Down → Up against a populated
// fixture and asserts the column lifecycle.
func TestMigration064_RoundTrip(t *testing.T) {
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

	if err := goose.UpToContext(ctx, db, "migrations", 64); err != nil {
		t.Fatalf("goose up to 64: %v", err)
	}

	la, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatalf("load LA: %v", err)
	}
	createdAt := time.Date(2026, 5, 10, 8, 20, 0, 0, la)
	notifiedAt := createdAt.Add(5 * time.Minute)
	approvedAt := createdAt.Add(15 * time.Minute)

	// Insert via raw SQL: schema-64 carries both legacy DATETIME and the new
	// *_unix columns. Use the producing time.Time so the driver writes its
	// t.String() format into legacy columns and pin the unix values.
	res, err := db.Exec(
		`INSERT INTO tz_transition_plans
			(old_tz, new_tz, status, steps_json, inputs_json, plan_hash,
			 created_at, notified_at, approved_at,
			 created_at_unix, notified_at_unix, approved_at_unix)
		 VALUES (?, ?, ?, '[]', '{}', ?, ?, ?, ?, ?, ?, ?)`,
		"UTC", "Europe/Berlin", "APPROVED", "rt-hash",
		createdAt, notifiedAt, approvedAt,
		createdAt.UTC().Unix(), notifiedAt.UTC().Unix(), approvedAt.UTC().Unix(),
	)
	if err != nil {
		t.Fatalf("seed insert: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("LastInsertId: %v", err)
	}

	var c int64
	var n, a sql.NullInt64
	if err := db.QueryRow("SELECT created_at_unix, notified_at_unix, approved_at_unix FROM tz_transition_plans WHERE id = ?", id).Scan(&c, &n, &a); err != nil {
		t.Fatalf("read unix cols: %v", err)
	}
	if c != createdAt.UTC().Unix() {
		t.Errorf("created_at_unix=%d want %d", c, createdAt.UTC().Unix())
	}
	if !n.Valid || n.Int64 != notifiedAt.UTC().Unix() {
		t.Errorf("notified_at_unix=%v want %d", n, notifiedAt.UTC().Unix())
	}
	if !a.Valid || a.Int64 != approvedAt.UTC().Unix() {
		t.Errorf("approved_at_unix=%v want %d", a, approvedAt.UTC().Unix())
	}

	// Down to 63 — columns should vanish.
	if err := goose.DownToContext(ctx, db, "migrations", 63); err != nil {
		t.Fatalf("goose down to 63: %v", err)
	}
	if columnExists(t, db, "tz_transition_plans", "created_at_unix") {
		t.Errorf("created_at_unix column should be dropped after Down")
	}
	if columnExists(t, db, "tz_transition_plans", "notified_at_unix") {
		t.Errorf("notified_at_unix column should be dropped after Down")
	}
	if columnExists(t, db, "tz_transition_plans", "approved_at_unix") {
		t.Errorf("approved_at_unix column should be dropped after Down")
	}

	// Up again — backfill re-populates from the legacy DATETIME strings.
	if err := goose.UpToContext(ctx, db, "migrations", 64); err != nil {
		t.Fatalf("goose up to 64 (second time): %v", err)
	}
	var c2 int64
	var n2, a2 sql.NullInt64
	if err := db.QueryRow("SELECT created_at_unix, notified_at_unix, approved_at_unix FROM tz_transition_plans WHERE id = ?", id).Scan(&c2, &n2, &a2); err != nil {
		t.Fatalf("read unix cols after re-up: %v", err)
	}
	if c2 != createdAt.UTC().Unix() {
		t.Errorf("after re-up: created_at_unix=%d want %d", c2, createdAt.UTC().Unix())
	}
	if !n2.Valid || n2.Int64 != notifiedAt.UTC().Unix() {
		t.Errorf("after re-up: notified_at_unix=%v want %d", n2, notifiedAt.UTC().Unix())
	}
	if !a2.Valid || a2.Int64 != approvedAt.UTC().Unix() {
		t.Errorf("after re-up: approved_at_unix=%v want %d", a2, approvedAt.UTC().Unix())
	}
}
