package medication

import (
	"database/sql"
	"testing"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/korjavin/medicationtrackerbot/internal/store/migrations"
	_ "modernc.org/sqlite"
)

// TestIntakeLogTimeColumnsAreInteger locks in the dose-time storage convention
// documented at the top of medication/repo.go and in docs/architecture.md →
// "Time storage": every dose-time column on intake_log must be stored as
// INTEGER unix-seconds-UTC, and the legacy text-typed (DATETIME) columns from
// the pre-2026-05-10 schema must not survive. A future migration that regresses
// any of these columns to DATETIME / TEXT will fail this test loudly.
func TestIntakeLogTimeColumnsAreInteger(t *testing.T) {
	d, err := storedb.Open(":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })

	if err := d.Migrate(migrations.FS, "."); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	rows, err := d.Query("PRAGMA table_info(intake_log)")
	if err != nil {
		t.Fatalf("PRAGMA table_info(intake_log): %v", err)
	}
	defer rows.Close()

	types := map[string]string{}
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			t.Fatalf("scan pragma row: %v", err)
		}
		types[name] = ctype
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows err: %v", err)
	}

	requiredIntegerColumns := []string{
		"scheduled_at_unix",
		"taken_at_unix",
		"snoozed_until_unix",
	}
	for _, col := range requiredIntegerColumns {
		ctype, ok := types[col]
		if !ok {
			t.Errorf("intake_log.%s: required dose-time column is missing — schema must declare it as INTEGER unix-seconds-UTC", col)
			continue
		}
		if ctype != "INTEGER" {
			t.Errorf("intake_log.%s: declared type=%q, want %q — dose-time columns must be INTEGER unix-seconds-UTC (see store.go convention comment / docs/architecture.md → Time storage)", col, ctype, "INTEGER")
		}
	}

	forbiddenTextColumns := []string{
		"scheduled_at",
		"taken_at",
		"snoozed_until",
	}
	for _, col := range forbiddenTextColumns {
		if ctype, ok := types[col]; ok {
			t.Errorf("intake_log.%s: legacy text-typed column survived (declared type=%q). It must be dropped by a table-rebuild migration; readers must use %s_unix instead.", col, ctype, col)
		}
	}
}
