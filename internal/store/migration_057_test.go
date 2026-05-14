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

// TestMigration057_BackfillsProductionTZFormats pins the Task 2 backfill
// assumption: SQLite's strftime('%s', col) correctly parses every datetime
// string format observed in production (`PDT`, `MST`, `CEST`, `UTC`) and
// produces the same unix seconds as the producing time.Time's t.Unix().
//
// If a format fails here, the migration must be upgraded to a Go-based goose
// migration that re-parses every row in Go (see plan Technical Details).
func TestMigration057_BackfillsProductionTZFormats(t *testing.T) {
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
		// Sub-second precision — CreateManualIntake writes scheduled_at = taken_at
		// where taken_at originates from time.Now(); .Truncate(0) strips monotonic
		// but preserves nanoseconds, and t.String() renders the fractional portion.
		{"CEST.frac", time.Date(2026, 5, 10, 17, 20, 0, 123456789, berlin)},
		{"CDT.frac", time.Date(2026, 5, 10, 9, 20, 0, 819544000, la)},
	}

	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	// Apply only the initial schema so we can write raw timestamps the way the
	// driver writes them, then run migration 057 manually.
	applyMigration(t, db, filepath.Join("migrations", "001_init.sql"))

	// Insert one row per format. We rely on modernc.org/sqlite to serialize
	// time.Time via t.String() — the same code path that produced the prod
	// strings the backfill must handle.
	if _, err := db.Exec("CREATE TABLE IF NOT EXISTS medications_dummy (id INTEGER)"); err != nil {
		t.Fatalf("create dummy: %v", err)
	}
	for i, c := range cases {
		// medication_id is unused in this test, just a placeholder integer.
		_, err := db.Exec(
			"INSERT INTO intake_log (medication_id, user_id, scheduled_at, status) VALUES (?, ?, ?, 'PENDING')",
			int64(i+1), int64(1), c.t,
		)
		if err != nil {
			t.Fatalf("insert row for %s: %v", c.name, err)
		}
	}

	// Also insert one row in the RFC3339-with-T format that newer modernc
	// builds may write (and that older rows might carry after a driver
	// upgrade). The migration's COALESCE branch must handle this too.
	rfcRow := time.Date(2026, 5, 10, 15, 20, 0, 0, time.UTC)
	if _, err := db.Exec(
		"INSERT INTO intake_log (medication_id, user_id, scheduled_at, status) VALUES (?, ?, ?, 'PENDING')",
		int64(999), int64(1), "2026-05-10T15:20:00Z",
	); err != nil {
		t.Fatalf("insert rfc3339 row: %v", err)
	}
	// And a colon'd-offset variant.
	if _, err := db.Exec(
		"INSERT INTO intake_log (medication_id, user_id, scheduled_at, status) VALUES (?, ?, ?, 'PENDING')",
		int64(998), int64(1), "2026-05-10T17:20:00+02:00",
	); err != nil {
		t.Fatalf("insert rfc3339+offset row: %v", err)
	}

	// Apply migration 057.
	applyMigration(t, db, filepath.Join("migrations", "057_add_intake_log_scheduled_at_unix.sql"))

	// Read back every row and assert scheduled_at_unix == t.Unix().
	rows, err := db.Query("SELECT id, scheduled_at_unix FROM intake_log ORDER BY id ASC")
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	got := map[int64]int64{}
	for rows.Next() {
		var id int64
		var u sql.NullInt64
		if err := rows.Scan(&id, &u); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if !u.Valid {
			t.Fatalf("row id=%d: scheduled_at_unix is NULL after backfill", id)
		}
		got[id] = u.Int64
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows err: %v", err)
	}

	for i, c := range cases {
		id := int64(i + 1)
		wantUnix := c.t.Unix()
		gotUnix, ok := got[id]
		if !ok {
			t.Fatalf("row id=%d (%s) not found after backfill", id, c.name)
		}
		if gotUnix != wantUnix {
			t.Errorf("%s: backfill produced unix=%d, want %d (input=%s, input.String()=%q)",
				c.name, gotUnix, wantUnix, c.t.Format(time.RFC3339), c.t.String())
		}
	}

	// And assert the two RFC3339-string-bound rows backfilled too.
	wantRFC := rfcRow.Unix()
	rfcID := int64(len(cases) + 1)
	if u, ok := got[rfcID]; !ok || u != wantRFC {
		t.Errorf("RFC3339 Z row: got %v, want %d (id=%d)", u, wantRFC, rfcID)
	}
	rfcOffsetID := int64(len(cases) + 2)
	if u, ok := got[rfcOffsetID]; !ok || u != wantRFC {
		t.Errorf("RFC3339 +02:00 row: got %v, want %d (id=%d)", u, wantRFC, rfcOffsetID)
	}
}

// TestMigration057_RoundTrip exercises goose Up → Down → Up against a populated
// fixture and asserts the column-and-index lifecycle.
func TestMigration057_RoundTrip(t *testing.T) {
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

	// Migrate up through 057.
	if err := goose.UpToContext(ctx, db, "migrations", 57); err != nil {
		t.Fatalf("goose up to 57: %v", err)
	}

	// Seed a row via raw SQL that still writes the legacy scheduled_at column.
	// This simulates the dual-write window that existed between Task 2 and
	// Task 4 (when the writer briefly populated both columns); we cannot use
	// CreateIntake here because, after Task 4 in the May 10 fix plan, that
	// writer stops writing scheduled_at and the column is still NOT NULL at
	// schema version 57.
	la, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatalf("load LA: %v", err)
	}
	medID := int64(42)
	userID := int64(1)
	sched := time.Date(2026, 5, 10, 8, 20, 0, 0, la)
	res, err := db.Exec(
		"INSERT INTO intake_log (medication_id, user_id, scheduled_at, scheduled_at_unix, status) VALUES (?, ?, ?, ?, 'PENDING')",
		medID, userID, sched, sched.UTC().Unix(),
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
	if err := db.QueryRow("SELECT scheduled_at_unix FROM intake_log WHERE id = ?", id).Scan(&u); err != nil {
		t.Fatalf("read scheduled_at_unix: %v", err)
	}
	if !u.Valid || u.Int64 != sched.UTC().Unix() {
		t.Errorf("scheduled_at_unix=%v want valid=true value=%d", u, sched.UTC().Unix())
	}

	// Assert index exists.
	if !indexExists(t, db, "idx_intake_log_scheduled_at_unix") {
		t.Errorf("expected index idx_intake_log_scheduled_at_unix to exist after up")
	}

	// Down to 56 — column and index should both vanish.
	if err := goose.DownToContext(ctx, db, "migrations", 56); err != nil {
		t.Fatalf("goose down to 56: %v", err)
	}
	if columnExists(t, db, "intake_log", "scheduled_at_unix") {
		t.Errorf("scheduled_at_unix column should be dropped after Down")
	}
	if indexExists(t, db, "idx_intake_log_scheduled_at_unix") {
		t.Errorf("idx_intake_log_scheduled_at_unix should be dropped after Down")
	}

	// Up again — backfill should re-populate from the legacy scheduled_at
	// string we wrote (modernc.org/sqlite t.String() format).
	if err := goose.UpToContext(ctx, db, "migrations", 57); err != nil {
		t.Fatalf("goose up to 57 (second time): %v", err)
	}
	var u2 sql.NullInt64
	if err := db.QueryRow("SELECT scheduled_at_unix FROM intake_log WHERE id = ?", id).Scan(&u2); err != nil {
		t.Fatalf("read scheduled_at_unix after re-up: %v", err)
	}
	if !u2.Valid || u2.Int64 != sched.UTC().Unix() {
		t.Errorf("after re-up: scheduled_at_unix=%v want valid=true value=%d", u2, sched.UTC().Unix())
	}
}

// TestCreateIntake_DualWritesScheduledAtUnix asserts that the writer normalizes
// the bound time.Time to UTC unix seconds at the store boundary, regardless of
// the caller-supplied location. This is the property that makes WHERE
// scheduled_at_unix = ? safe to use across TZ changes.
func TestCreateIntake_DualWritesScheduledAtUnix(t *testing.T) {
	db := setupTestStore(t)

	la, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatalf("load LA: %v", err)
	}
	phoenix, err := time.LoadLocation("America/Phoenix")
	if err != nil {
		t.Fatalf("load Phoenix: %v", err)
	}

	medID, err := db.Medication.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["08:20"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication: %v", err)
	}

	// LA: 2026-05-10 08:20 PDT (-07:00) = 2026-05-10 15:20 UTC = unix 1778426400
	schedLA := time.Date(2026, 5, 10, 8, 20, 0, 0, la)
	wantUnix := schedLA.UTC().Unix()
	idLA, err := db.Medication.CreateIntake(medID, 1, schedLA)
	if err != nil {
		t.Fatalf("CreateIntake (LA): %v", err)
	}

	var gotUnix sql.NullInt64
	if err := db.db.QueryRow("SELECT scheduled_at_unix FROM intake_log WHERE id = ?", idLA).Scan(&gotUnix); err != nil {
		t.Fatalf("read scheduled_at_unix: %v", err)
	}
	if !gotUnix.Valid {
		t.Fatalf("scheduled_at_unix is NULL for LA write")
	}
	if gotUnix.Int64 != wantUnix {
		t.Errorf("LA write: scheduled_at_unix=%d want %d", gotUnix.Int64, wantUnix)
	}

	// Phoenix: same wall clock 08:20 but MST (-07:00). Same UTC offset as PDT,
	// but a different Location and TZ name. The unix value MUST match.
	schedPhx := time.Date(2026, 5, 10, 8, 20, 0, 0, phoenix)
	idPhx, err := db.Medication.CreateIntake(medID, 1, schedPhx)
	if err != nil {
		t.Fatalf("CreateIntake (Phoenix): %v", err)
	}
	var gotUnixPhx sql.NullInt64
	if err := db.db.QueryRow("SELECT scheduled_at_unix FROM intake_log WHERE id = ?", idPhx).Scan(&gotUnixPhx); err != nil {
		t.Fatalf("read scheduled_at_unix (Phx): %v", err)
	}
	if !gotUnixPhx.Valid {
		t.Fatalf("scheduled_at_unix is NULL for Phx write")
	}
	if gotUnixPhx.Int64 != wantUnix {
		t.Errorf("Phoenix write: scheduled_at_unix=%d want %d (must match LA — same instant)",
			gotUnixPhx.Int64, wantUnix)
	}

	// SQL equality on the new column matches both rows for the same instant.
	var count int
	if err := db.db.QueryRow("SELECT COUNT(*) FROM intake_log WHERE scheduled_at_unix = ?", wantUnix).Scan(&count); err != nil {
		t.Fatalf("count by scheduled_at_unix: %v", err)
	}
	if count != 2 {
		t.Errorf("WHERE scheduled_at_unix = ? matched %d rows, want 2 (the TZ-name-equality bug class)", count)
	}
}

// TestCreateManualIntake_DualWritesScheduledAtUnix mirrors the assertion for
// the manual-confirm path, which sets scheduled_at = taken_at at write time.
func TestCreateManualIntake_DualWritesScheduledAtUnix(t *testing.T) {
	db := setupTestStore(t)

	berlin, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatalf("load Berlin: %v", err)
	}

	medID, err := db.Medication.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["08:20"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication: %v", err)
	}

	taken := time.Date(2026, 5, 10, 17, 20, 0, 0, berlin)
	wantUnix := taken.UTC().Unix()
	id, err := db.Medication.CreateManualIntake(medID, 1, taken)
	if err != nil {
		t.Fatalf("CreateManualIntake: %v", err)
	}

	var u sql.NullInt64
	if err := db.db.QueryRow("SELECT scheduled_at_unix FROM intake_log WHERE id = ?", id).Scan(&u); err != nil {
		t.Fatalf("read scheduled_at_unix: %v", err)
	}
	if !u.Valid || u.Int64 != wantUnix {
		t.Errorf("scheduled_at_unix=%v want valid=true value=%d", u, wantUnix)
	}
}

func columnExists(t *testing.T, db *sql.DB, table, column string) bool {
	t.Helper()
	rows, err := db.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		t.Fatalf("PRAGMA table_info: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			t.Fatalf("scan pragma row: %v", err)
		}
		if name == column {
			return true
		}
	}
	return false
}

func indexExists(t *testing.T, db *sql.DB, name string) bool {
	t.Helper()
	var n int
	err := db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?", name).Scan(&n)
	if err != nil {
		t.Fatalf("query sqlite_master: %v", err)
	}
	return n > 0
}
