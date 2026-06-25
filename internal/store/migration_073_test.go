package store

import (
	"context"
	"database/sql"
	"testing"

	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"
)

// colSpec describes one expected column: its declared SQLite type and NOT NULL
// flag. Shared by the migration 073 schema assertions below.
type colSpec struct {
	name    string
	ctype   string
	notnull int
}

// assertColumns checks that every expected column exists on the table with the
// declared SQLite type and NOT NULL flag.
func assertColumns(t *testing.T, db *sql.DB, table string, want []colSpec) {
	t.Helper()
	got := pragmaColumns(t, db, table)
	for _, w := range want {
		c, ok := got[w.name]
		if !ok {
			t.Errorf("%s.%s: column missing", table, w.name)
			continue
		}
		if c.ctype != w.ctype {
			t.Errorf("%s.%s: declared type=%q, want %q", table, w.name, c.ctype, w.ctype)
		}
		if c.notnull != w.notnull {
			t.Errorf("%s.%s: notnull=%d, want %d", table, w.name, c.notnull, w.notnull)
		}
	}
}

// TestMigration073_CreatesGamificationSchema covers docs/plans/
// 2026-06-25-gamification-1-backend-core.md Task 1: migration 073 adds the
// three gamification tables (targets / ledger / state), the default-ON
// settings.gamification_enabled flag, the lookup indexes, and the
// change-event triggers tagged 'gamification'.
func TestMigration073_CreatesGamificationSchema(t *testing.T) {
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

	// Apply up to migration 072 (last revision before the new tables). The
	// gamification tables must not exist yet — guards against accidental
	// migration re-ordering.
	if err := goose.UpToContext(ctx, db, "migrations", 72); err != nil {
		t.Fatalf("goose up to 72: %v", err)
	}
	for _, tbl := range []string{"gamification_targets", "gamification_ledger", "gamification_state"} {
		if tableExists(t, db, tbl) {
			t.Fatalf("%s should not exist before migration 073", tbl)
		}
	}
	if columnExists(t, db, "settings", "gamification_enabled") {
		t.Fatal("settings.gamification_enabled should not exist before migration 073")
	}

	if err := goose.UpToContext(ctx, db, "migrations", 73); err != nil {
		t.Fatalf("goose up to 73: %v", err)
	}

	// All three tables exist after the migration.
	for _, tbl := range []string{"gamification_targets", "gamification_ledger", "gamification_state"} {
		if !tableExists(t, db, tbl) {
			t.Fatalf("%s should exist after migration 073", tbl)
		}
	}

	assertColumns(t, db, "gamification_targets", []colSpec{
		{"id", "INTEGER", 0},
		{"user_id", "INTEGER", 1},
		{"metric_key", "TEXT", 1},
		{"low_val", "REAL", 0},
		{"high_val", "REAL", 0},
		{"falloff", "REAL", 0},
		{"mode", "TEXT", 0},
		{"updated_at_unix", "INTEGER", 1},
	})

	// gamification_ledger — day_unix must be INTEGER (TZ-safe dedupe key).
	assertColumns(t, db, "gamification_ledger", []colSpec{
		{"id", "INTEGER", 0},
		{"user_id", "INTEGER", 1},
		{"day_unix", "INTEGER", 1},
		{"ring", "TEXT", 1},
		{"source_metric", "TEXT", 1},
		{"kind", "TEXT", 1},
		{"hp", "INTEGER", 1},
		{"detail", "TEXT", 0},
		{"created_at_unix", "INTEGER", 1},
	})

	assertColumns(t, db, "gamification_state", []colSpec{
		{"user_id", "INTEGER", 0},
		{"lifetime_hp", "INTEGER", 1},
		{"level", "INTEGER", 1},
		{"current_streak", "INTEGER", 1},
		{"longest_streak", "INTEGER", 1},
		{"freezes", "INTEGER", 1},
		{"insight_tier", "INTEGER", 1},
		{"last_scored_day_unix", "INTEGER", 0},
		{"updated_at_unix", "INTEGER", 1},
	})

	// Lookup indexes.
	if !indexExists(t, db, "idx_gam_ledger_user_day") {
		t.Error("idx_gam_ledger_user_day should exist after migration 073")
	}
	if !indexExists(t, db, "idx_gam_targets_user") {
		t.Error("idx_gam_targets_user should exist after migration 073")
	}

	// settings.gamification_enabled exists and defaults to 1 (default-ON).
	if !columnExists(t, db, "settings", "gamification_enabled") {
		t.Fatal("settings.gamification_enabled should exist after migration 073")
	}
	var enabled sql.NullInt64
	if err := db.QueryRow(`SELECT gamification_enabled FROM settings WHERE id = 1`).Scan(&enabled); err != nil {
		t.Fatalf("read gamification_enabled: %v", err)
	}
	if !enabled.Valid || enabled.Int64 != 1 {
		t.Errorf("gamification_enabled default = %+v, want 1 (default-ON)", enabled)
	}

	// The UNIQUE constraint on the ledger makes INSERT OR REPLACE idempotent:
	// re-inserting the same dedupe key replaces rather than duplicating.
	insLedger := func(hp int64) {
		t.Helper()
		if _, err := db.Exec(
			`INSERT OR REPLACE INTO gamification_ledger
			 (user_id, day_unix, ring, source_metric, kind, hp, detail, created_at_unix)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			int64(42), int64(1750809600), "adherence", "meds", "floor", hp, "{}", int64(1750812345),
		); err != nil {
			t.Fatalf("insert ledger: %v", err)
		}
	}
	insLedger(10)
	insLedger(25) // same dedupe key → replace
	var rows int
	var totalHP sql.NullInt64
	if err := db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(hp),0) FROM gamification_ledger`).Scan(&rows, &totalHP); err != nil {
		t.Fatalf("count ledger: %v", err)
	}
	if rows != 1 {
		t.Errorf("ledger rows = %d, want 1 (UNIQUE dedupe replaced)", rows)
	}
	if !totalHP.Valid || totalHP.Int64 != 25 {
		t.Errorf("ledger hp = %+v, want 25 (replaced value)", totalHP)
	}

	// The change-event triggers fire under the 'gamification' tag.
	var gamEvents int
	if err := db.QueryRow(`SELECT COUNT(*) FROM change_events WHERE tag = 'gamification'`).Scan(&gamEvents); err != nil {
		t.Fatalf("count gamification change_events: %v", err)
	}
	if gamEvents == 0 {
		t.Error("expected at least one change_events row tagged 'gamification' after ledger writes")
	}
}

// TestMigration073_RoundTrip exercises goose Up → Down → Up across 073. The
// three tables, both indexes, the triggers, and the settings.gamification_enabled
// column must all vanish on down and reappear on re-up — symmetric down keeps
// re-up's ADD COLUMN from hitting a duplicate-column error (mirrors migration
// 022's feature toggles).
func TestMigration073_RoundTrip(t *testing.T) {
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

	if err := goose.UpToContext(ctx, db, "migrations", 73); err != nil {
		t.Fatalf("goose up to 73: %v", err)
	}
	for _, tbl := range []string{"gamification_targets", "gamification_ledger", "gamification_state"} {
		if !tableExists(t, db, tbl) {
			t.Fatalf("%s missing after first up", tbl)
		}
	}

	if err := goose.DownToContext(ctx, db, "migrations", 72); err != nil {
		t.Fatalf("goose down to 72: %v", err)
	}
	for _, tbl := range []string{"gamification_targets", "gamification_ledger", "gamification_state"} {
		if tableExists(t, db, tbl) {
			t.Fatalf("%s should be dropped after down to 72", tbl)
		}
	}
	if indexExists(t, db, "idx_gam_ledger_user_day") || indexExists(t, db, "idx_gam_targets_user") {
		t.Fatal("gamification indexes should be dropped after down to 72")
	}
	if columnExists(t, db, "settings", "gamification_enabled") {
		t.Fatal("settings.gamification_enabled should be dropped after down to 72")
	}

	if err := goose.UpToContext(ctx, db, "migrations", 73); err != nil {
		t.Fatalf("goose re-up to 73: %v", err)
	}
	for _, tbl := range []string{"gamification_targets", "gamification_ledger", "gamification_state"} {
		if !tableExists(t, db, tbl) {
			t.Fatalf("%s missing after re-up", tbl)
		}
	}
	if !columnExists(t, db, "settings", "gamification_enabled") {
		t.Fatal("settings.gamification_enabled should reappear after re-up")
	}
}
