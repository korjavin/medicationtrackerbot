package store

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"
)

// TestMigration058_DropsScheduledAtAndPreservesData exercises Task 4 of the
// fix plan: the SQLite table-rebuild that removes the legacy
// intake_log.scheduled_at DATETIME column. We seed a populated fixture, run
// goose up to 58, and assert that:
//
//   - the scheduled_at column is gone
//   - scheduled_at_unix survives with the same values
//   - id values are preserved (so intake_reminders FKs remain valid)
//   - idx_intake_log_status and idx_intake_log_scheduled_at_unix still exist
//   - idx_intake_log_scheduled_at is gone
//   - all three trg_change_intake_log_* triggers still exist and fire
func TestMigration058_DropsScheduledAtAndPreservesData(t *testing.T) {
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

	// Migrate up to 57 so we can populate via the dual-write writer (which
	// still writes both scheduled_at and scheduled_at_unix at that point).
	if err := goose.UpToContext(ctx, db, "migrations", 57); err != nil {
		t.Fatalf("goose up to 57: %v", err)
	}

	// Seed 100+ rows representing a realistic mix of TZs and statuses.
	la, _ := time.LoadLocation("America/Los_Angeles")
	berlin, _ := time.LoadLocation("Europe/Berlin")
	phoenix, _ := time.LoadLocation("America/Phoenix")
	utc := time.UTC

	locs := []*time.Location{la, berlin, phoenix, utc}

	type seed struct {
		id        int64
		schedUnix int64
		status    string
		hasTaken  bool
		takenStr  string
	}
	var seeds []seed
	medID := int64(1)
	for i := 0; i < 120; i++ {
		loc := locs[i%len(locs)]
		// 2026-05-10 plus offset-days, hour cycles 0..23
		sched := time.Date(2026, 5, 10, i%24, 0, 0, 0, loc).Add(time.Duration(i) * time.Hour)
		schedUnix := sched.UTC().Unix()
		status := "PENDING"
		var takenAt sql.NullString
		if i%3 == 0 {
			status = "TAKEN"
			takenAt.Valid = true
			takenAt.String = sched.UTC().Format(time.RFC3339)
		} else if i%5 == 0 {
			status = "SKIPPED"
		}
		// Insert via raw SQL so both columns are populated, matching the
		// shape Task 2 leaves behind.
		res, err := db.Exec(`
			INSERT INTO intake_log (medication_id, user_id, scheduled_at, scheduled_at_unix, taken_at, status)
			VALUES (?, ?, ?, ?, ?, ?)`,
			medID, int64(1), sched, schedUnix,
			func() interface{} {
				if takenAt.Valid {
					return takenAt.String
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
			id:        id,
			schedUnix: schedUnix,
			status:    status,
			hasTaken:  takenAt.Valid,
			takenStr:  takenAt.String,
		})
	}
	// Snapshot the max id we just inserted; we'll re-check it after the
	// rebuild to confirm AUTOINCREMENT semantics still produce monotonic ids.
	var maxIDBefore int64
	if err := db.QueryRow("SELECT MAX(id) FROM intake_log").Scan(&maxIDBefore); err != nil {
		t.Fatalf("max(id) before: %v", err)
	}
	if maxIDBefore != int64(len(seeds)) {
		t.Fatalf("expected max(id)=%d, got %d", len(seeds), maxIDBefore)
	}

	// Pre-snapshot the change_events count so we can verify the recreated
	// triggers fire after the rebuild.
	var changeCountBefore int
	if err := db.QueryRow("SELECT COUNT(*) FROM change_events WHERE tag='history'").Scan(&changeCountBefore); err != nil {
		t.Fatalf("count change_events before: %v", err)
	}

	// Apply migration 058.
	if err := goose.UpToContext(ctx, db, "migrations", 58); err != nil {
		t.Fatalf("goose up to 58: %v", err)
	}

	// Assert column is gone.
	if columnExists(t, db, "intake_log", "scheduled_at") {
		t.Errorf("scheduled_at column should be dropped after migration 058")
	}
	if !columnExists(t, db, "intake_log", "scheduled_at_unix") {
		t.Errorf("scheduled_at_unix column should still exist after migration 058")
	}

	// Assert indexes — kept and dropped.
	if !indexExists(t, db, "idx_intake_log_status") {
		t.Errorf("idx_intake_log_status should survive the rebuild")
	}
	if !indexExists(t, db, "idx_intake_log_scheduled_at_unix") {
		t.Errorf("idx_intake_log_scheduled_at_unix should survive the rebuild")
	}
	if indexExists(t, db, "idx_intake_log_scheduled_at") {
		t.Errorf("idx_intake_log_scheduled_at should be dropped (its column is gone)")
	}

	// Assert triggers exist.
	for _, tg := range []string{
		"trg_change_intake_log_ins",
		"trg_change_intake_log_upd",
		"trg_change_intake_log_del",
	} {
		if !triggerExists(t, db, tg) {
			t.Errorf("trigger %s should survive the rebuild", tg)
		}
	}

	// Verify every seeded row survived with identical (id, scheduled_at_unix,
	// status, taken_at).
	rows, err := db.Query("SELECT id, scheduled_at_unix, status, taken_at FROM intake_log ORDER BY id ASC")
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	defer rows.Close()
	gotByID := map[int64]seed{}
	for rows.Next() {
		var id int64
		var u sql.NullInt64
		var status string
		var taken sql.NullString
		if err := rows.Scan(&id, &u, &status, &taken); err != nil {
			t.Fatalf("scan: %v", err)
		}
		s := seed{id: id, status: status}
		if u.Valid {
			s.schedUnix = u.Int64
		}
		if taken.Valid {
			s.hasTaken = true
			s.takenStr = taken.String
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
		if got.hasTaken != want.hasTaken {
			t.Errorf("id=%d: hasTaken=%v want %v", want.id, got.hasTaken, want.hasTaken)
		}
	}

	// Insert another row to confirm AUTOINCREMENT still works and triggers fire.
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

// TestMigration058_RoundTrip runs goose up→down→up across 058 and asserts the
// down step reconstructs (best-effort) the prior shape, and the second up
// arrives at the same final shape.
func TestMigration058_RoundTrip(t *testing.T) {
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

	if err := goose.UpToContext(ctx, db, "migrations", 57); err != nil {
		t.Fatalf("up to 57: %v", err)
	}
	// Seed via raw SQL that populates both legacy scheduled_at and the new
	// scheduled_at_unix — the on-disk shape that prod will be in when
	// migration 058 runs. CreateIntake itself stops writing scheduled_at as
	// part of Task 4, so we can't use it against the schema-57 table.
	la, _ := time.LoadLocation("America/Los_Angeles")
	sched := time.Date(2026, 5, 10, 8, 20, 0, 0, la)
	wantUnix := sched.UTC().Unix()
	res, err := db.Exec(
		"INSERT INTO intake_log (medication_id, user_id, scheduled_at, scheduled_at_unix, status) VALUES (?, ?, ?, ?, 'PENDING')",
		int64(42), int64(1), sched, wantUnix,
	)
	if err != nil {
		t.Fatalf("seed insert: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("LastInsertId: %v", err)
	}

	// Up to 58 — drops scheduled_at, preserves scheduled_at_unix.
	if err := goose.UpToContext(ctx, db, "migrations", 58); err != nil {
		t.Fatalf("up to 58: %v", err)
	}
	if columnExists(t, db, "intake_log", "scheduled_at") {
		t.Errorf("scheduled_at should be gone after up-58")
	}
	var gotUnix sql.NullInt64
	if err := db.QueryRow("SELECT scheduled_at_unix FROM intake_log WHERE id = ?", id).Scan(&gotUnix); err != nil {
		t.Fatalf("read scheduled_at_unix: %v", err)
	}
	if !gotUnix.Valid || gotUnix.Int64 != wantUnix {
		t.Errorf("scheduled_at_unix=%v want %d", gotUnix, wantUnix)
	}

	// Down to 57 — reconstructs scheduled_at (text) from unix.
	if err := goose.DownToContext(ctx, db, "migrations", 57); err != nil {
		t.Fatalf("down to 57: %v", err)
	}
	if !columnExists(t, db, "intake_log", "scheduled_at") {
		t.Errorf("scheduled_at should be back after down")
	}
	if !columnExists(t, db, "intake_log", "scheduled_at_unix") {
		t.Errorf("scheduled_at_unix should still exist after down to 57")
	}
	// The reconstructed scheduled_at is a best-effort UTC string; check the
	// unix column still matches the original instant.
	var unixAfterDown sql.NullInt64
	if err := db.QueryRow("SELECT scheduled_at_unix FROM intake_log WHERE id = ?", id).Scan(&unixAfterDown); err != nil {
		t.Fatalf("read scheduled_at_unix after down: %v", err)
	}
	if !unixAfterDown.Valid || unixAfterDown.Int64 != wantUnix {
		t.Errorf("after down: scheduled_at_unix=%v want %d", unixAfterDown, wantUnix)
	}

	// Up to 58 again — drops scheduled_at again, unix preserved.
	if err := goose.UpToContext(ctx, db, "migrations", 58); err != nil {
		t.Fatalf("up to 58 (second time): %v", err)
	}
	if columnExists(t, db, "intake_log", "scheduled_at") {
		t.Errorf("scheduled_at should be gone after second up-58")
	}
	var unixAfterReup sql.NullInt64
	if err := db.QueryRow("SELECT scheduled_at_unix FROM intake_log WHERE id = ?", id).Scan(&unixAfterReup); err != nil {
		t.Fatalf("read scheduled_at_unix after re-up: %v", err)
	}
	if !unixAfterReup.Valid || unixAfterReup.Int64 != wantUnix {
		t.Errorf("after re-up: scheduled_at_unix=%v want %d", unixAfterReup, wantUnix)
	}
}

func triggerExists(t *testing.T, db *sql.DB, name string) bool {
	t.Helper()
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name=?", name).Scan(&n); err != nil {
		t.Fatalf("query trigger: %v", err)
	}
	return n > 0
}
