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

// TestMigration061_BackfillsProductionSnoozedUntilFormats pins the Task 6
// backfill assumption: every datetime string format observed in production for
// the intake_log.snoozed_until column (the same set as taken_at — `PDT`,
// `MST`, `CEST`, `UTC`, RFC3339, and the monotonic-clock-residue variant) is
// parseable by SQLite's strftime path (direct or via the substr-reformat
// fallback) and produces the same unix seconds as the producing time.Time's
// t.Unix().
func TestMigration061_BackfillsProductionSnoozedUntilFormats(t *testing.T) {
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
		// CEST: prod server TZ during summer.
		{"CEST", time.Date(2026, 5, 10, 17, 20, 0, 0, berlin)},
		// CET: prod server TZ during winter.
		{"CET", time.Date(2026, 1, 15, 18, 20, 0, 0, berlin)},
		// PDT: LA during summer.
		{"PDT", time.Date(2026, 5, 10, 8, 20, 0, 0, la)},
		// MST: Phoenix (same offset as PDT but different zone name).
		{"MST", time.Date(2026, 5, 10, 8, 20, 0, 0, phoenix)},
		// UTC: vanilla path.
		{"UTC", time.Date(2026, 5, 10, 15, 20, 0, 0, time.UTC)},
		// PST: LA during winter.
		{"PST", time.Date(2026, 1, 15, 9, 0, 0, 0, la)},
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

	// Apply migrations up to 060 — schema with intake_log carrying
	// snoozed_until DATETIME but no snoozed_until_unix yet.
	if err := goose.UpToContext(ctx, db, "migrations", 60); err != nil {
		t.Fatalf("goose up to 60: %v", err)
	}

	// Insert one row per format. modernc.org/sqlite serializes the bound
	// time.Time via t.String() — the same code path that produced prod
	// snoozed_until strings the backfill must handle.
	caseIDs := make([]int64, len(cases))
	for i, c := range cases {
		res, err := db.Exec(
			"INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, snoozed_until, status) VALUES (?, ?, ?, ?, 'PENDING')",
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

	// RFC3339 Z + RFC3339-with-offset variants (newer driver formats).
	rfcRow := time.Date(2026, 5, 10, 15, 20, 0, 0, time.UTC)
	rfcZID := insertSnoozedRaw(t, db, rfcRow.UTC().Unix(), "2026-05-10T15:20:00Z")
	rfcOffsetID := insertSnoozedRaw(t, db, rfcRow.UTC().Unix(), "2026-05-10T17:20:00+02:00")
	// Monotonic-clock residue: t.String() leaks "m=+201.247835759" onto the
	// end. The substr fallback only reads positions 1..25, so the trailing
	// monotonic suffix is ignored.
	monotonicID := insertSnoozedRaw(t, db, rfcRow.UTC().Unix(),
		"2026-05-10 17:20:00 +0200 CEST m=+201.247835759")

	// NULL snoozed_until row — must remain NULL after backfill.
	res, err := db.Exec(
		"INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, snoozed_until, status) VALUES (?, ?, ?, NULL, 'PENDING')",
		int64(996), int64(1), int64(1778426400),
	)
	if err != nil {
		t.Fatalf("insert null snoozed_until row: %v", err)
	}
	nullID, _ := res.LastInsertId()

	// Apply migration 061 manually so it runs against the populated fixture.
	applyMigration(t, db, filepath.Join("migrations", "061_add_intake_log_snoozed_until_unix.sql"))

	// Read back every row and assert snoozed_until_unix == t.Unix().
	rows, err := db.Query("SELECT id, snoozed_until, snoozed_until_unix FROM intake_log ORDER BY id ASC")
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	type got struct {
		raw    sql.NullString
		intVal sql.NullInt64
	}
	gotByID := map[int64]got{}
	for rows.Next() {
		var id int64
		var ts sql.NullString
		var u sql.NullInt64
		if err := rows.Scan(&id, &ts, &u); err != nil {
			t.Fatalf("scan: %v", err)
		}
		gotByID[id] = got{raw: ts, intVal: u}
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
		if !g.intVal.Valid {
			t.Fatalf("%s: row id=%d snoozed_until_unix is NULL after backfill (input=%q)",
				c.name, id, c.t.String())
		}
		if g.intVal.Int64 != wantUnix {
			t.Errorf("%s: backfill produced unix=%d, want %d (input.String()=%q)",
				c.name, g.intVal.Int64, wantUnix, c.t.String())
		}
	}

	wantRFC := rfcRow.Unix()
	for _, id := range []int64{rfcZID, rfcOffsetID, monotonicID} {
		g, ok := gotByID[id]
		if !ok {
			t.Fatalf("row id=%d not found", id)
		}
		if !g.intVal.Valid || g.intVal.Int64 != wantRFC {
			t.Errorf("row id=%d: snoozed_until_unix=%v want %d (input=%q)", id, g.intVal, wantRFC, g.raw.String)
		}
	}

	g, ok := gotByID[nullID]
	if !ok {
		t.Fatalf("null row missing")
	}
	if g.intVal.Valid {
		t.Errorf("null row snoozed_until_unix should be NULL, got valid=true value=%d", g.intVal.Int64)
	}
}

func insertSnoozedRaw(t *testing.T, db *sql.DB, schedUnix int64, snoozedStr string) int64 {
	t.Helper()
	res, err := db.Exec(
		"INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, snoozed_until, status) VALUES (?, ?, ?, ?, 'PENDING')",
		int64(1), int64(1), schedUnix, snoozedStr,
	)
	if err != nil {
		t.Fatalf("insert snoozed_until=%q: %v", snoozedStr, err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("LastInsertId: %v", err)
	}
	return id
}

// TestMigration061_RoundTrip exercises goose Up → Down → Up against a populated
// fixture and asserts the column lifecycle (no index to track for snoozed_until_unix).
func TestMigration061_RoundTrip(t *testing.T) {
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

	if err := goose.UpToContext(ctx, db, "migrations", 61); err != nil {
		t.Fatalf("goose up to 61: %v", err)
	}

	la, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatalf("load LA: %v", err)
	}
	medID := int64(42)
	userID := int64(1)
	sched := time.Date(2026, 5, 10, 8, 20, 0, 0, la)
	snoozed := sched.Add(15 * time.Minute)

	// Insert via raw SQL: schema-61 carries both legacy snoozed_until and the
	// new snoozed_until_unix. Use the producing time.Time so the driver writes
	// its t.String() format into snoozed_until.
	res, err := db.Exec(
		"INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, snoozed_until, snoozed_until_unix, status) VALUES (?, ?, ?, ?, ?, 'PENDING')",
		medID, userID, sched.UTC().Unix(), snoozed, snoozed.UTC().Unix(),
	)
	if err != nil {
		t.Fatalf("seed insert: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("LastInsertId: %v", err)
	}

	var u sql.NullInt64
	if err := db.QueryRow("SELECT snoozed_until_unix FROM intake_log WHERE id = ?", id).Scan(&u); err != nil {
		t.Fatalf("read snoozed_until_unix: %v", err)
	}
	if !u.Valid || u.Int64 != snoozed.UTC().Unix() {
		t.Errorf("snoozed_until_unix=%v want valid=true value=%d", u, snoozed.UTC().Unix())
	}

	// Down to 60 — column should vanish.
	if err := goose.DownToContext(ctx, db, "migrations", 60); err != nil {
		t.Fatalf("goose down to 60: %v", err)
	}
	if columnExists(t, db, "intake_log", "snoozed_until_unix") {
		t.Errorf("snoozed_until_unix column should be dropped after Down")
	}

	// Up again — backfill re-populates from the legacy snoozed_until string.
	if err := goose.UpToContext(ctx, db, "migrations", 61); err != nil {
		t.Fatalf("goose up to 61 (second time): %v", err)
	}
	var u2 sql.NullInt64
	if err := db.QueryRow("SELECT snoozed_until_unix FROM intake_log WHERE id = ?", id).Scan(&u2); err != nil {
		t.Fatalf("read snoozed_until_unix after re-up: %v", err)
	}
	if !u2.Valid || u2.Int64 != snoozed.UTC().Unix() {
		t.Errorf("after re-up: snoozed_until_unix=%v want valid=true value=%d", u2, snoozed.UTC().Unix())
	}
}

// TestSnoozeIntake_WritesSnoozedUntilUnixUTC asserts that SnoozeIntake
// normalizes the bound time.Time to UTC unix seconds at the store boundary,
// regardless of the caller-supplied location. The "same instant in two
// different time.Locations" case is the bug class this column shape closes.
func TestSnoozeIntake_WritesSnoozedUntilUnixUTC(t *testing.T) {
	db := setupTestStore(t)

	la, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatalf("load LA: %v", err)
	}
	phoenix, err := time.LoadLocation("America/Phoenix")
	if err != nil {
		t.Fatalf("load Phoenix: %v", err)
	}

	medID, err := db.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["08:20"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication: %v", err)
	}

	scheduledAt := time.Date(2026, 5, 10, 8, 20, 0, 0, la)
	id, err := db.CreateIntake(medID, 1, scheduledAt)
	if err != nil {
		t.Fatalf("CreateIntake: %v", err)
	}

	// Snooze with a time.Time in LA. UTC unix seconds for 08:35 PDT.
	snoozeLA := time.Date(2026, 5, 10, 8, 35, 0, 0, la)
	wantUnix := snoozeLA.UTC().Unix()
	if err := db.SnoozeIntake(id, snoozeLA); err != nil {
		t.Fatalf("SnoozeIntake: %v", err)
	}
	var u sql.NullInt64
	if err := db.db.QueryRow("SELECT snoozed_until_unix FROM intake_log WHERE id = ?", id).Scan(&u); err != nil {
		t.Fatalf("read snoozed_until_unix: %v", err)
	}
	if !u.Valid || u.Int64 != wantUnix {
		t.Errorf("LA: snoozed_until_unix=%v want %d", u, wantUnix)
	}

	// Snooze again with the same wall clock in Phoenix (MST = -07:00, same
	// offset as PDT but different zone name). Should produce the same UTC
	// unix seconds — closing the TZ-name equality bug class.
	medID2, err := db.CreateMedication("Vitamin", "1tab", `{"type":"daily","times":["08:20"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication 2: %v", err)
	}
	id2, err := db.CreateIntake(medID2, 1, scheduledAt)
	if err != nil {
		t.Fatalf("CreateIntake 2: %v", err)
	}
	snoozePhx := time.Date(2026, 5, 10, 8, 35, 0, 0, phoenix)
	if err := db.SnoozeIntake(id2, snoozePhx); err != nil {
		t.Fatalf("SnoozeIntake Phoenix: %v", err)
	}
	var uPhx sql.NullInt64
	if err := db.db.QueryRow("SELECT snoozed_until_unix FROM intake_log WHERE id = ?", id2).Scan(&uPhx); err != nil {
		t.Fatalf("read snoozed_until_unix (Phx): %v", err)
	}
	if !uPhx.Valid || uPhx.Int64 != wantUnix {
		t.Errorf("Phoenix: snoozed_until_unix=%v want %d (must match LA — same instant)", uPhx, wantUnix)
	}

	// Round-trip via GetPendingIntakes: the *time.Time read back is UTC,
	// matches the original instant, and has no monotonic residue.
	pendings, err := db.GetPendingIntakes()
	if err != nil {
		t.Fatalf("GetPendingIntakes: %v", err)
	}
	var found *IntakeLog
	for i := range pendings {
		if pendings[i].ID == id {
			found = &pendings[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("could not find intake id=%d in pending list", id)
	}
	if found.SnoozedUntil == nil {
		t.Fatalf("SnoozedUntil unexpectedly nil after snooze")
	}
	if !found.SnoozedUntil.Equal(snoozeLA) {
		t.Errorf("SnoozedUntil=%s, want same instant as %s",
			found.SnoozedUntil.Format(time.RFC3339), snoozeLA.Format(time.RFC3339))
	}
	if found.SnoozedUntil.Location() != time.UTC {
		t.Errorf("SnoozedUntil.Location()=%v, want UTC", found.SnoozedUntil.Location())
	}
}

// TestSnoozeIntake_StripsMonotonicResidue ensures that time.Now()'s monotonic
// component does not survive the write boundary for snoozed_until_unix.
func TestSnoozeIntake_StripsMonotonicResidue(t *testing.T) {
	db := setupTestStore(t)

	medID, err := db.CreateMedication("Med", "5mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication: %v", err)
	}

	scheduledAt := time.Date(2026, 5, 10, 8, 0, 0, 0, time.UTC)
	id, err := db.CreateIntake(medID, 1, scheduledAt)
	if err != nil {
		t.Fatalf("CreateIntake: %v", err)
	}

	// time.Now() carries a monotonic clock component. The writer must strip
	// it via .UTC() before binding so it doesn't leak into the DB.
	now := time.Now()
	if err := db.SnoozeIntake(id, now); err != nil {
		t.Fatalf("SnoozeIntake: %v", err)
	}

	got, err := db.GetIntake(id)
	if err != nil {
		t.Fatalf("GetIntake: %v", err)
	}
	if got == nil || got.SnoozedUntil == nil {
		t.Fatalf("expected non-nil SnoozedUntil after snooze")
	}

	if got.SnoozedUntil.Round(0) != *got.SnoozedUntil {
		t.Errorf("SnoozedUntil unexpectedly carries monotonic clock data: %v", got.SnoozedUntil)
	}

	wantTrunc := now.Truncate(time.Second)
	if !got.SnoozedUntil.Equal(wantTrunc) {
		t.Errorf("SnoozedUntil=%s, want same instant as %s (truncated to seconds)",
			got.SnoozedUntil.Format(time.RFC3339Nano), wantTrunc.Format(time.RFC3339Nano))
	}

	if got.SnoozedUntil.Location() != time.UTC {
		t.Errorf("SnoozedUntil.Location()=%v, want UTC", got.SnoozedUntil.Location())
	}
}
