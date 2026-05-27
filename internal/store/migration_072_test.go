package store

import (
	"context"
	"database/sql"
	"testing"

	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"
)

// TestMigration072_CreatesWeightGoalsHistoryTable covers the schema delta
// from docs/plans/2026-05-27-weight-goal-trajectory-snapshot.md Task 1:
// migration 072 adds an append-only weight_goals table (per-user history of
// SetGoal calls) and its (user_id, set_at_unix DESC) lookup index. The
// legacy settings.weight_goal{,_date} singleton columns must remain
// untouched — the chart's fallback path depends on them for legacy goals.
func TestMigration072_CreatesWeightGoalsHistoryTable(t *testing.T) {
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

	// Apply up to migration 071 (last revision before the new table). The
	// table must not exist yet — guards against accidental migration
	// re-ordering.
	if err := goose.UpToContext(ctx, db, "migrations", 71); err != nil {
		t.Fatalf("goose up to 71: %v", err)
	}
	if tableExists(t, db, "weight_goals") {
		t.Fatal("weight_goals should not exist before migration 072")
	}

	// Seed a legacy goal on the singleton settings row so we can prove it
	// survives the new migration unchanged.
	if _, err := db.Exec(`UPDATE settings SET weight_goal = 75.5, weight_goal_date = '2026-12-31' WHERE id = 1`); err != nil {
		t.Fatalf("seed legacy goal: %v", err)
	}

	if err := goose.UpToContext(ctx, db, "migrations", 72); err != nil {
		t.Fatalf("goose up to 72: %v", err)
	}

	if !tableExists(t, db, "weight_goals") {
		t.Fatal("weight_goals should exist after migration 072")
	}

	// All declared columns must be present with the documented types.
	type colSpec struct {
		name    string
		ctype   string
		notnull int
	}
	want := []colSpec{
		{"id", "INTEGER", 0},
		{"user_id", "INTEGER", 1},
		{"set_at_unix", "INTEGER", 1},
		{"target_weight", "REAL", 1},
		{"target_date", "TEXT", 1},
		{"start_weight", "REAL", 0},
	}
	got := pragmaColumns(t, db, "weight_goals")
	for _, w := range want {
		c, ok := got[w.name]
		if !ok {
			t.Errorf("weight_goals.%s: column missing", w.name)
			continue
		}
		if c.ctype != w.ctype {
			t.Errorf("weight_goals.%s: declared type=%q, want %q", w.name, c.ctype, w.ctype)
		}
		if c.notnull != w.notnull {
			t.Errorf("weight_goals.%s: notnull=%d, want %d", w.name, c.notnull, w.notnull)
		}
	}

	// The lookup index must exist.
	if !indexExists(t, db, "idx_weight_goals_user_set_at") {
		t.Error("idx_weight_goals_user_set_at should exist after migration 072")
	}

	// Legacy goal on settings must be untouched.
	var goal sql.NullFloat64
	var goalDate sql.NullString
	if err := db.QueryRow(`SELECT weight_goal, weight_goal_date FROM settings WHERE id = 1`).Scan(&goal, &goalDate); err != nil {
		t.Fatalf("read legacy goal: %v", err)
	}
	if !goal.Valid || goal.Float64 != 75.5 {
		t.Errorf("legacy weight_goal lost or changed: %+v", goal)
	}
	if !goalDate.Valid || goalDate.String != "2026-12-31" {
		t.Errorf("legacy weight_goal_date lost or changed: %+v", goalDate)
	}

	// Sanity: an INSERT works with the documented shape.
	if _, err := db.Exec(
		`INSERT INTO weight_goals (user_id, set_at_unix, target_weight, target_date, start_weight)
		 VALUES (?, ?, ?, ?, ?)`,
		int64(42), int64(1748390400), 70.0, "2026-09-30", 72.5,
	); err != nil {
		t.Fatalf("insert into weight_goals: %v", err)
	}

	// And a NULL start_weight is accepted (the "no prior log" case).
	if _, err := db.Exec(
		`INSERT INTO weight_goals (user_id, set_at_unix, target_weight, target_date, start_weight)
		 VALUES (?, ?, ?, ?, NULL)`,
		int64(42), int64(1748390500), 71.0, "2026-10-31",
	); err != nil {
		t.Fatalf("insert null start_weight: %v", err)
	}
}

// TestMigration072_RoundTrip exercises goose Up → Down → Up across 072. The
// table + index must vanish on down and reappear on re-up; the down step is
// destructive (rows lost) so we only verify schema-shape round-trip.
func TestMigration072_RoundTrip(t *testing.T) {
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

	if err := goose.UpToContext(ctx, db, "migrations", 72); err != nil {
		t.Fatalf("goose up to 72: %v", err)
	}
	if !tableExists(t, db, "weight_goals") {
		t.Fatal("weight_goals missing after first up")
	}
	if !indexExists(t, db, "idx_weight_goals_user_set_at") {
		t.Fatal("idx_weight_goals_user_set_at missing after first up")
	}

	if err := goose.DownToContext(ctx, db, "migrations", 71); err != nil {
		t.Fatalf("goose down to 71: %v", err)
	}
	if tableExists(t, db, "weight_goals") {
		t.Fatal("weight_goals should be dropped after down to 71")
	}
	if indexExists(t, db, "idx_weight_goals_user_set_at") {
		t.Fatal("idx_weight_goals_user_set_at should be dropped after down to 71")
	}

	if err := goose.UpToContext(ctx, db, "migrations", 72); err != nil {
		t.Fatalf("goose re-up to 72: %v", err)
	}
	if !tableExists(t, db, "weight_goals") {
		t.Fatal("weight_goals missing after re-up")
	}
	if !indexExists(t, db, "idx_weight_goals_user_set_at") {
		t.Fatal("idx_weight_goals_user_set_at missing after re-up")
	}
}

type columnInfo struct {
	ctype   string
	notnull int
}

func pragmaColumns(t *testing.T, db *sql.DB, table string) map[string]columnInfo {
	t.Helper()
	rows, err := db.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		t.Fatalf("PRAGMA table_info(%s): %v", table, err)
	}
	defer rows.Close()
	out := map[string]columnInfo{}
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			t.Fatalf("scan pragma row: %v", err)
		}
		out[name] = columnInfo{ctype: ctype, notnull: notnull}
	}
	return out
}

