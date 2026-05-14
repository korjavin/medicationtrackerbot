package medication

import (
	"testing"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/korjavin/medicationtrackerbot/internal/store/migrations"
)

// setupMedicationRepo opens an in-memory SQLite database, runs all migrations,
// and returns a fresh medication.Repo. Each test gets its own DB.
func setupMedicationRepo(t *testing.T) *Repo {
	t.Helper()
	d, err := storedb.Open(":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := d.Migrate(migrations.FS, "."); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return New(d)
}

// intPtr is a tiny convenience helper used by the inventory tests for the
// medications.inventory_count *int column.
func intPtr(i int) *int { return &i }
