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

// TestMigration059_BackfillsProductionTakenAtFormats pins the Task 5 backfill
// assumption: every datetime string format observed in production for the
// intake_log.taken_at column (`PDT`, `MST`, `CEST`, `UTC`, RFC3339, and the
// monotonic-clock-residue variant) is parseable by SQLite's strftime path
// (direct or via the substr-reformat fallback) and produces the same unix
// seconds as the producing time.Time's t.Unix().
//
// If a format fails here, the migration must be upgraded to a Go-based goose
// migration that re-parses every row in Go.
func TestMigration059_BackfillsProductionTakenAtFormats(t *testing.T) {
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
		// CEST: prod server TZ during summer (today's taken_at rows)
		{"CEST", time.Date(2026, 5, 10, 17, 20, 0, 0, berlin)},
		// CET: prod server TZ during winter
		{"CET", time.Date(2026, 1, 15, 18, 20, 0, 0, berlin)},
		// PDT: today's incident, LA before flight
		{"PDT", time.Date(2026, 5, 10, 8, 20, 0, 0, la)},
		// MST: today's incident, Phoenix after flight (same offset, different name)
		{"MST", time.Date(2026, 5, 10, 8, 20, 0, 0, phoenix)},
		// UTC: vanilla path
		{"UTC", time.Date(2026, 5, 10, 15, 20, 0, 0, time.UTC)},
		// PST: LA winter
		{"PST", time.Date(2026, 1, 15, 9, 0, 0, 0, la)},
		// Sub-second precision — ConfirmIntake/UpdateIntake feed time.Now() into
		// the taken_at writer; .Truncate(0) strips monotonic but preserves
		// nanoseconds, and t.String() renders the fractional portion. The
		// no-fraction substr formula breaks on this; the dynamic-position
		// formula handles both.
		{"CEST.frac", time.Date(2026, 5, 10, 17, 20, 0, 123456789, berlin)},
		{"CDT.frac", time.Date(2026, 5, 10, 9, 20, 0, 819544000, la)},
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

	// Apply up to migration 058 so we have a schema with intake_log
	// (sans the legacy scheduled_at column) but BEFORE migration 059 adds
	// taken_at_unix.
	if err := goose.UpToContext(ctx, db, "migrations", 58); err != nil {
		t.Fatalf("goose up to 58: %v", err)
	}

	// Insert one row per format via raw SQL. We rely on modernc.org/sqlite to
	// serialize time.Time via t.String() — the same code path that produced
	// the prod taken_at strings the backfill must handle. scheduled_at_unix
	// is required (NOT NULL not enforced, but we populate for realism).
	caseIDs := make([]int64, len(cases))
	for i, c := range cases {
		res, err := db.Exec(
			"INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, taken_at, status) VALUES (?, ?, ?, ?, 'TAKEN')",
			int64(i+1), int64(1), c.t.UTC().Unix(), c.t,
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

	// RFC3339 Z (also a possible driver-write format).
	rfcRow := time.Date(2026, 5, 10, 15, 20, 0, 0, time.UTC)
	rfcZID := insertTakenAtRaw(t, db, rfcRow.UTC().Unix(), "2026-05-10T15:20:00Z", "TAKEN")
	// RFC3339 with explicit offset.
	rfcOffsetID := insertTakenAtRaw(t, db, rfcRow.UTC().Unix(), "2026-05-10T17:20:00+02:00", "TAKEN")
	// Monotonic-clock residue: t.String() leaks "m=+201.247835759" onto the end.
	// Migration 059's substr fallback only reads positions 1..25 of the string,
	// so the trailing monotonic suffix is ignored.
	monotonicID := insertTakenAtRaw(t, db, rfcRow.UTC().Unix(),
		"2026-05-10 17:20:00 +0200 CEST m=+201.247835759", "TAKEN")

	// One NULL taken_at row — must remain NULL after backfill.
	res, err := db.Exec(
		"INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, taken_at, status) VALUES (?, ?, ?, NULL, 'PENDING')",
		int64(996), int64(1), int64(1778426400),
	)
	if err != nil {
		t.Fatalf("insert null taken_at row: %v", err)
	}
	nullID, _ := res.LastInsertId()

	// Apply migration 059.
	applyMigration(t, db, filepath.Join("migrations", "059_add_intake_log_taken_at_unix.sql"))

	// Read back every row and assert taken_at_unix == t.Unix().
	rows, err := db.Query("SELECT id, taken_at, taken_at_unix FROM intake_log ORDER BY id ASC")
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	type got struct {
		taken    sql.NullString
		takenInt sql.NullInt64
	}
	gotByID := map[int64]got{}
	for rows.Next() {
		var id int64
		var ts sql.NullString
		var u sql.NullInt64
		if err := rows.Scan(&id, &ts, &u); err != nil {
			t.Fatalf("scan: %v", err)
		}
		gotByID[id] = got{taken: ts, takenInt: u}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows err: %v", err)
	}

	for i, c := range cases {
		id := caseIDs[i]
		wantUnix := c.t.Unix()
		g, ok := gotByID[id]
		if !ok {
			t.Fatalf("row id=%d (%s) not found after backfill", id, c.name)
		}
		if !g.takenInt.Valid {
			t.Fatalf("%s: row id=%d taken_at_unix is NULL after backfill (input=%q)",
				c.name, id, c.t.String())
		}
		if g.takenInt.Int64 != wantUnix {
			t.Errorf("%s: backfill produced unix=%d, want %d (input.String()=%q)",
				c.name, g.takenInt.Int64, wantUnix, c.t.String())
		}
	}

	// RFC3339 Z + offset + monotonic
	wantRFC := rfcRow.Unix()
	for _, id := range []int64{rfcZID, rfcOffsetID, monotonicID} {
		g, ok := gotByID[id]
		if !ok {
			t.Fatalf("row id=%d not found", id)
		}
		if !g.takenInt.Valid || g.takenInt.Int64 != wantRFC {
			t.Errorf("row id=%d: taken_at_unix=%v want %d (input=%q)", id, g.takenInt, wantRFC, g.taken.String)
		}
	}

	// NULL row must remain NULL.
	g, ok := gotByID[nullID]
	if !ok {
		t.Fatalf("null row missing")
	}
	if g.takenInt.Valid {
		t.Errorf("null row taken_at_unix should be NULL, got valid=true value=%d", g.takenInt.Int64)
	}
}

func insertTakenAtRaw(t *testing.T, db *sql.DB, schedUnix int64, takenAtStr, status string) int64 {
	t.Helper()
	res, err := db.Exec(
		"INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, taken_at, status) VALUES (?, ?, ?, ?, ?)",
		int64(1), int64(1), schedUnix, takenAtStr, status,
	)
	if err != nil {
		t.Fatalf("insert taken_at=%q: %v", takenAtStr, err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("LastInsertId: %v", err)
	}
	return id
}

// TestMigration059_RoundTrip exercises goose Up → Down → Up against a
// populated fixture and asserts the column-and-index lifecycle.
func TestMigration059_RoundTrip(t *testing.T) {
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

	if err := goose.UpToContext(ctx, db, "migrations", 59); err != nil {
		t.Fatalf("goose up to 59: %v", err)
	}

	la, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatalf("load LA: %v", err)
	}
	medID := int64(42)
	userID := int64(1)
	sched := time.Date(2026, 5, 10, 8, 20, 0, 0, la)
	taken := sched.Add(5 * time.Minute)
	// Insert via raw SQL: schema-59 carries both legacy taken_at and the new
	// taken_at_unix. Use the producing time.Time so the driver writes its
	// t.String() format.
	res, err := db.Exec(
		"INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, taken_at, taken_at_unix, status) VALUES (?, ?, ?, ?, ?, 'TAKEN')",
		medID, userID, sched.UTC().Unix(), taken, taken.UTC().Unix(),
	)
	if err != nil {
		t.Fatalf("seed insert: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("LastInsertId: %v", err)
	}

	// Assert column was populated.
	var u sql.NullInt64
	if err := db.QueryRow("SELECT taken_at_unix FROM intake_log WHERE id = ?", id).Scan(&u); err != nil {
		t.Fatalf("read taken_at_unix: %v", err)
	}
	if !u.Valid || u.Int64 != taken.UTC().Unix() {
		t.Errorf("taken_at_unix=%v want valid=true value=%d", u, taken.UTC().Unix())
	}

	// Assert index exists.
	if !indexExists(t, db, "idx_intake_log_taken_at_unix") {
		t.Errorf("expected index idx_intake_log_taken_at_unix to exist after up")
	}

	// Down to 58 — column and index should both vanish.
	if err := goose.DownToContext(ctx, db, "migrations", 58); err != nil {
		t.Fatalf("goose down to 58: %v", err)
	}
	if columnExists(t, db, "intake_log", "taken_at_unix") {
		t.Errorf("taken_at_unix column should be dropped after Down")
	}
	if indexExists(t, db, "idx_intake_log_taken_at_unix") {
		t.Errorf("idx_intake_log_taken_at_unix should be dropped after Down")
	}

	// Up again — backfill should re-populate from the legacy taken_at string
	// we wrote (modernc.org/sqlite t.String() format).
	if err := goose.UpToContext(ctx, db, "migrations", 59); err != nil {
		t.Fatalf("goose up to 59 (second time): %v", err)
	}
	var u2 sql.NullInt64
	if err := db.QueryRow("SELECT taken_at_unix FROM intake_log WHERE id = ?", id).Scan(&u2); err != nil {
		t.Fatalf("read taken_at_unix after re-up: %v", err)
	}
	if !u2.Valid || u2.Int64 != taken.UTC().Unix() {
		t.Errorf("after re-up: taken_at_unix=%v want valid=true value=%d", u2, taken.UTC().Unix())
	}
}

// TestCreateManualIntake_DualWritesTakenAtUnix asserts that CreateManualIntake
// normalizes the bound time.Time to UTC unix seconds for the taken_at_unix
// column at the store boundary, regardless of caller-supplied location.
func TestCreateManualIntake_DualWritesTakenAtUnix(t *testing.T) {
	db := setupTestStore(t)

	la, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatalf("load LA: %v", err)
	}
	phoenix, err := time.LoadLocation("America/Phoenix")
	if err != nil {
		t.Fatalf("load Phoenix: %v", err)
	}

	medID, err := db.Medication.Create("Aspirin", "100mg", `{"type":"daily","times":["08:20"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	takenLA := time.Date(2026, 5, 10, 8, 20, 0, 0, la)
	wantUnix := takenLA.UTC().Unix()
	idLA, err := db.Medication.CreateManualIntake(medID, 1, takenLA)
	if err != nil {
		t.Fatalf("CreateManualIntake (LA): %v", err)
	}

	var u sql.NullInt64
	if err := db.db.QueryRow("SELECT taken_at_unix FROM intake_log WHERE id = ?", idLA).Scan(&u); err != nil {
		t.Fatalf("read taken_at_unix (LA): %v", err)
	}
	if !u.Valid || u.Int64 != wantUnix {
		t.Errorf("LA: taken_at_unix=%v want %d", u, wantUnix)
	}

	// Same wall clock 08:20 in Phoenix (MST = -07:00, same offset as PDT but
	// different name and Location).
	takenPhx := time.Date(2026, 5, 10, 8, 20, 0, 0, phoenix)
	idPhx, err := db.Medication.CreateManualIntake(medID, 1, takenPhx)
	if err != nil {
		t.Fatalf("CreateManualIntake (Phoenix): %v", err)
	}
	var uPhx sql.NullInt64
	if err := db.db.QueryRow("SELECT taken_at_unix FROM intake_log WHERE id = ?", idPhx).Scan(&uPhx); err != nil {
		t.Fatalf("read taken_at_unix (Phx): %v", err)
	}
	if !uPhx.Valid || uPhx.Int64 != wantUnix {
		t.Errorf("Phoenix: taken_at_unix=%v want %d (must match LA — same instant)", uPhx, wantUnix)
	}

	// SQL equality on the column matches both rows for the same instant.
	var count int
	if err := db.db.QueryRow("SELECT COUNT(*) FROM intake_log WHERE taken_at_unix = ?", wantUnix).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 2 {
		t.Errorf("WHERE taken_at_unix = ? matched %d rows, want 2", count)
	}
}

// TestConfirmIntake_StripsMonotonicResidue ensures that time.Now()'s monotonic
// component does not survive the write boundary. Specifically: after
// ConfirmIntake(id, time.Now()), reading back the row produces a time with no
// monotonic residue that compares correctly via time.Equal.
func TestConfirmIntake_StripsMonotonicResidue(t *testing.T) {
	db := setupTestStore(t)

	medID, err := db.Medication.Create("Med", "5mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	scheduledAt := time.Date(2026, 5, 10, 8, 0, 0, 0, time.UTC)
	id, err := db.Medication.CreateIntake(medID, 1, scheduledAt)
	if err != nil {
		t.Fatalf("CreateIntake: %v", err)
	}

	// time.Now() carries a monotonic clock component. The writer must strip it
	// via .UTC() before binding so it doesn't leak into the DB.
	now := time.Now()
	if err := db.Medication.ConfirmIntake(id, now); err != nil {
		t.Fatalf("ConfirmIntake: %v", err)
	}

	got, err := db.Medication.GetIntake(id)
	if err != nil {
		t.Fatalf("GetIntake: %v", err)
	}
	if got == nil || got.TakenAt == nil {
		t.Fatalf("expected non-nil TakenAt after confirm")
	}

	// The round-tripped value must have no monotonic component: t.Round(0)
	// returns t with the monotonic clock stripped, so if t == t.Round(0)
	// the monotonic part was already zero.
	if got.TakenAt.Round(0) != *got.TakenAt {
		t.Errorf("TakenAt unexpectedly carries monotonic clock data: %v", got.TakenAt)
	}

	// The stored value must equal the original wall-clock instant (truncated to
	// seconds, since taken_at_unix is INTEGER seconds).
	wantTrunc := now.Truncate(time.Second)
	if !got.TakenAt.Equal(wantTrunc) {
		t.Errorf("TakenAt=%s, want same instant as %s (truncated to seconds)",
			got.TakenAt.Format(time.RFC3339Nano), wantTrunc.Format(time.RFC3339Nano))
	}

	// And the read-back value should be in UTC.
	if got.TakenAt.Location() != time.UTC {
		t.Errorf("TakenAt.Location()=%v, want UTC", got.TakenAt.Location())
	}
}
