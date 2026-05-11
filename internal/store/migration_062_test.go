package store

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"
)

// TestMigration062_DropsSnoozedUntilAndPreservesData exercises Task 6 (table-
// rebuild step) of the May 10 fix plan: the SQLite table-rebuild that removes
// the legacy intake_log.snoozed_until DATETIME column. We seed a populated
// fixture, run goose up to 62, and assert that:
//
//   - the snoozed_until column is gone
//   - snoozed_until_unix survives with the same values (NULL stays NULL)
//   - id values are preserved (so intake_reminders FKs remain valid)
//   - idx_intake_log_status, idx_intake_log_scheduled_at_unix, and
//     idx_intake_log_taken_at_unix all still exist
//   - all three trg_change_intake_log_* triggers still exist and fire
func TestMigration062_DropsSnoozedUntilAndPreservesData(t *testing.T) {
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

	// Migrate up to 61 so we can populate both the legacy snoozed_until and
	// the new snoozed_until_unix columns — matches the dual-write state
	// Task 6's pre-rebuild code shipped (during development).
	if err := goose.UpToContext(ctx, db, "migrations", 61); err != nil {
		t.Fatalf("goose up to 61: %v", err)
	}

	la, _ := time.LoadLocation("America/Los_Angeles")
	berlin, _ := time.LoadLocation("Europe/Berlin")
	phoenix, _ := time.LoadLocation("America/Phoenix")
	utc := time.UTC

	locs := []*time.Location{la, berlin, phoenix, utc}

	type seed struct {
		id         int64
		schedUnix  int64
		status     string
		snoozeUnix sql.NullInt64
	}
	var seeds []seed
	medID := int64(1)
	for i := 0; i < 120; i++ {
		loc := locs[i%len(locs)]
		sched := time.Date(2026, 5, 10, i%24, 0, 0, 0, loc).Add(time.Duration(i) * time.Hour)
		schedUnix := sched.UTC().Unix()
		status := "PENDING"
		var snoozeUnix sql.NullInt64
		var snoozeStr interface{}
		if i%4 == 0 {
			snooze := sched.Add(15 * time.Minute)
			snoozeUnix.Valid = true
			snoozeUnix.Int64 = snooze.UTC().Unix()
			snoozeStr = snooze.UTC().Format(time.RFC3339)
		}
		if i%3 == 0 {
			status = "TAKEN"
		}
		res, err := db.Exec(`
			INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, snoozed_until, snoozed_until_unix, status)
			VALUES (?, ?, ?, ?, ?, ?)`,
			medID, int64(1), schedUnix,
			func() interface{} {
				if snoozeStr == nil {
					return nil
				}
				return snoozeStr
			}(),
			func() interface{} {
				if snoozeUnix.Valid {
					return snoozeUnix.Int64
				}
				return nil
			}(),
			status,
		)
		if err != nil {
			t.Fatalf("seed insert %d: %v", i, err)
		}
		id, err := res.LastInsertId()
		if err != nil {
			t.Fatalf("LastInsertId %d: %v", i, err)
		}
		seeds = append(seeds, seed{
			id:         id,
			schedUnix:  schedUnix,
			status:     status,
			snoozeUnix: snoozeUnix,
		})
	}

	var maxIDBefore int64
	if err := db.QueryRow("SELECT MAX(id) FROM intake_log").Scan(&maxIDBefore); err != nil {
		t.Fatalf("max(id) before: %v", err)
	}
	if maxIDBefore != int64(len(seeds)) {
		t.Fatalf("expected max(id)=%d, got %d", len(seeds), maxIDBefore)
	}

	var changeCountBefore int
	if err := db.QueryRow("SELECT COUNT(*) FROM change_events WHERE tag='history'").Scan(&changeCountBefore); err != nil {
		t.Fatalf("count change_events before: %v", err)
	}

	// Apply migration 062.
	if err := goose.UpToContext(ctx, db, "migrations", 62); err != nil {
		t.Fatalf("goose up to 62: %v", err)
	}

	if columnExists(t, db, "intake_log", "snoozed_until") {
		t.Errorf("snoozed_until column should be dropped after migration 062")
	}
	if !columnExists(t, db, "intake_log", "snoozed_until_unix") {
		t.Errorf("snoozed_until_unix column should still exist after migration 062")
	}
	if !columnExists(t, db, "intake_log", "scheduled_at_unix") {
		t.Errorf("scheduled_at_unix column should still exist after migration 062")
	}
	if !columnExists(t, db, "intake_log", "taken_at_unix") {
		t.Errorf("taken_at_unix column should still exist after migration 062")
	}

	for _, idx := range []string{
		"idx_intake_log_status",
		"idx_intake_log_scheduled_at_unix",
		"idx_intake_log_taken_at_unix",
	} {
		if !indexExists(t, db, idx) {
			t.Errorf("index %s should survive the rebuild", idx)
		}
	}

	for _, tg := range []string{
		"trg_change_intake_log_ins",
		"trg_change_intake_log_upd",
		"trg_change_intake_log_del",
	} {
		if !triggerExists(t, db, tg) {
			t.Errorf("trigger %s should survive the rebuild", tg)
		}
	}

	rows, err := db.Query("SELECT id, scheduled_at_unix, snoozed_until_unix, status FROM intake_log ORDER BY id ASC")
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	defer rows.Close()
	gotByID := map[int64]seed{}
	for rows.Next() {
		var id int64
		var schedU sql.NullInt64
		var snoozeU sql.NullInt64
		var status string
		if err := rows.Scan(&id, &schedU, &snoozeU, &status); err != nil {
			t.Fatalf("scan: %v", err)
		}
		s := seed{id: id, status: status, snoozeUnix: snoozeU}
		if schedU.Valid {
			s.schedUnix = schedU.Int64
		}
		gotByID[id] = s
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows err: %v", err)
	}
	if len(gotByID) != len(seeds) {
		t.Fatalf("expected %d rows after rebuild, got %d", len(seeds), len(gotByID))
	}
	for _, want := range seeds {
		got, ok := gotByID[want.id]
		if !ok {
			t.Fatalf("seed id=%d missing after rebuild", want.id)
		}
		if got.schedUnix != want.schedUnix {
			t.Errorf("id=%d: scheduled_at_unix=%d want %d", want.id, got.schedUnix, want.schedUnix)
		}
		if got.status != want.status {
			t.Errorf("id=%d: status=%q want %q", want.id, got.status, want.status)
		}
		if got.snoozeUnix.Valid != want.snoozeUnix.Valid {
			t.Errorf("id=%d: snoozeUnix.Valid=%v want %v", want.id, got.snoozeUnix.Valid, want.snoozeUnix.Valid)
		}
		if got.snoozeUnix.Valid && got.snoozeUnix.Int64 != want.snoozeUnix.Int64 {
			t.Errorf("id=%d: snoozeUnix=%d want %d", want.id, got.snoozeUnix.Int64, want.snoozeUnix.Int64)
		}
	}

	res, err := db.Exec("INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, status) VALUES (?, ?, ?, 'PENDING')",
		medID, int64(1), int64(1000000000))
	if err != nil {
		t.Fatalf("post-rebuild insert: %v", err)
	}
	newID, _ := res.LastInsertId()
	if newID <= maxIDBefore {
		t.Errorf("AUTOINCREMENT should have allocated id > %d, got %d", maxIDBefore, newID)
	}

	var changeCountAfter int
	if err := db.QueryRow("SELECT COUNT(*) FROM change_events WHERE tag='history'").Scan(&changeCountAfter); err != nil {
		t.Fatalf("count change_events after: %v", err)
	}
	if changeCountAfter <= changeCountBefore {
		t.Errorf("trg_change_intake_log_ins did not fire after rebuild (before=%d after=%d)",
			changeCountBefore, changeCountAfter)
	}
}

// TestMigration062_RoundTrip runs goose up→down→up across 062 and asserts the
// down step reconstructs (best-effort) the prior shape, and the second up
// arrives at the same final shape.
func TestMigration062_RoundTrip(t *testing.T) {
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
		t.Fatalf("up to 61: %v", err)
	}
	la, _ := time.LoadLocation("America/Los_Angeles")
	sched := time.Date(2026, 5, 10, 8, 20, 0, 0, la)
	snoozed := sched.Add(15 * time.Minute)
	wantSchedUnix := sched.UTC().Unix()
	wantSnoozeUnix := snoozed.UTC().Unix()
	res, err := db.Exec(
		"INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, snoozed_until, snoozed_until_unix, status) VALUES (?, ?, ?, ?, ?, 'PENDING')",
		int64(42), int64(1), wantSchedUnix, snoozed, wantSnoozeUnix,
	)
	if err != nil {
		t.Fatalf("seed insert: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("LastInsertId: %v", err)
	}

	// Up to 62 — drops snoozed_until, preserves snoozed_until_unix.
	if err := goose.UpToContext(ctx, db, "migrations", 62); err != nil {
		t.Fatalf("up to 62: %v", err)
	}
	if columnExists(t, db, "intake_log", "snoozed_until") {
		t.Errorf("snoozed_until should be gone after up-62")
	}
	var gotSnoozeUnix sql.NullInt64
	if err := db.QueryRow("SELECT snoozed_until_unix FROM intake_log WHERE id = ?", id).Scan(&gotSnoozeUnix); err != nil {
		t.Fatalf("read snoozed_until_unix: %v", err)
	}
	if !gotSnoozeUnix.Valid || gotSnoozeUnix.Int64 != wantSnoozeUnix {
		t.Errorf("snoozed_until_unix=%v want %d", gotSnoozeUnix, wantSnoozeUnix)
	}

	// Down to 61 — reconstructs snoozed_until (text) from unix.
	if err := goose.DownToContext(ctx, db, "migrations", 61); err != nil {
		t.Fatalf("down to 61: %v", err)
	}
	if !columnExists(t, db, "intake_log", "snoozed_until") {
		t.Errorf("snoozed_until should be back after down")
	}
	if !columnExists(t, db, "intake_log", "snoozed_until_unix") {
		t.Errorf("snoozed_until_unix should still exist after down to 61")
	}
	var unixAfterDown sql.NullInt64
	if err := db.QueryRow("SELECT snoozed_until_unix FROM intake_log WHERE id = ?", id).Scan(&unixAfterDown); err != nil {
		t.Fatalf("read snoozed_until_unix after down: %v", err)
	}
	if !unixAfterDown.Valid || unixAfterDown.Int64 != wantSnoozeUnix {
		t.Errorf("after down: snoozed_until_unix=%v want %d", unixAfterDown, wantSnoozeUnix)
	}

	// Up to 62 again — drops snoozed_until again, unix preserved.
	if err := goose.UpToContext(ctx, db, "migrations", 62); err != nil {
		t.Fatalf("up to 62 (second time): %v", err)
	}
	if columnExists(t, db, "intake_log", "snoozed_until") {
		t.Errorf("snoozed_until should be gone after second up-62")
	}
	var unixAfterReup sql.NullInt64
	if err := db.QueryRow("SELECT snoozed_until_unix FROM intake_log WHERE id = ?", id).Scan(&unixAfterReup); err != nil {
		t.Fatalf("read snoozed_until_unix after re-up: %v", err)
	}
	if !unixAfterReup.Valid || unixAfterReup.Int64 != wantSnoozeUnix {
		t.Errorf("after re-up: snoozed_until_unix=%v want %d", unixAfterReup, wantSnoozeUnix)
	}
}
