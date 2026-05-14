package store

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// applyMigration applies the Up section of a single goose migration file to db.
// Used by migration_NNN_test.go files that need a specific historical schema
// state before exercising a follow-up migration. Lives in this shared helper
// file (formerly inside workout_test.go) so it survives the per-domain split.
func applyMigration(t *testing.T, db *sql.DB, migrationFile string) {
	t.Helper()
	schemaBytes, err := os.ReadFile(filepath.Clean(migrationFile)) // #nosec G304
	if err != nil {
		t.Fatalf("Failed to read migration file %s: %v", migrationFile, err)
	}

	schemaSQL := string(schemaBytes)
	upStart := strings.Index(schemaSQL, "-- +goose Up")
	downStart := strings.Index(schemaSQL, "-- +goose Down")

	if upStart == -1 || downStart == -1 {
		t.Fatalf("Migration file %s doesn't contain goose directives", migrationFile)
	}

	upSQL := schemaSQL[upStart:downStart]
	upSQL = strings.TrimPrefix(upSQL, "-- +goose Up")
	upSQL = strings.TrimSpace(upSQL)

	if _, err := db.Exec(upSQL); err != nil {
		t.Fatalf("Failed to execute migration %s: %v", migrationFile, err)
	}
}

// intPtr is a tiny convenience helper used across test files in this package.
// Lives here (formerly inside workout_test.go) so it survives the per-domain
// split — the inventory and medication tests still reference it.
func intPtr(i int) *int { return &i }
