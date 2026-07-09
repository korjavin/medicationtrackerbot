package store

import (
	"context"
	"database/sql"
	"testing"

	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"
)

func TestMigration075_MakesTargetDateNullable(t *testing.T) {
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

	// Apply up to migration 072
	if err := goose.UpToContext(ctx, db, "migrations", 72); err != nil {
		t.Fatalf("goose up to 72: %v", err)
	}

	// Insert old data with '0001-01-01'
	if _, err := db.Exec(
		`INSERT INTO weight_goals (user_id, set_at_unix, target_weight, target_date, start_weight)
		 VALUES (?, ?, ?, ?, ?)`,
		int64(42), int64(1748390400), 70.0, "0001-01-01", 72.5,
	); err != nil {
		t.Fatalf("insert into weight_goals before migration: %v", err)
	}

	// Apply 075
	if err := goose.UpToContext(ctx, db, "migrations", 75); err != nil {
		t.Fatalf("goose up to 73: %v", err)
	}

	// Verify column is nullable
	got := pragmaColumns(t, db, "weight_goals")
	if c, ok := got["target_date"]; !ok || c.notnull != 0 {
		t.Errorf("weight_goals.target_date: expected notnull=0, got %+v", c)
	}

	// Verify old sentinel data is migrated to NULL
	var targetDate sql.NullString
	if err := db.QueryRow(`SELECT target_date FROM weight_goals WHERE user_id = 42`).Scan(&targetDate); err != nil {
		t.Fatalf("query migrated data: %v", err)
	}
	if targetDate.Valid {
		t.Errorf("expected target_date to be migrated to NULL, got %s", targetDate.String)
	}

	// Verify we can insert a real NULL
	if _, err := db.Exec(
		`INSERT INTO weight_goals (user_id, set_at_unix, target_weight, target_date, start_weight)
		 VALUES (?, ?, ?, NULL, ?)`,
		int64(42), int64(1748390500), 65.0, 70.0,
	); err != nil {
		t.Fatalf("insert NULL target_date: %v", err)
	}
}
