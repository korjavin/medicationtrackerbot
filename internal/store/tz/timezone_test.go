package tz

import (
	"testing"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/korjavin/medicationtrackerbot/internal/store/migrations"
)

// setupTZRepo creates an in-memory DB with all migrations and a tz repo.
func setupTZRepo(t *testing.T) *Repo {
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

func TestGetCurrentTimezone_EmptyTable(t *testing.T) {
	r := setupTZRepo(t)

	tz, err := r.GetCurrent()
	if err != nil {
		t.Fatalf("GetCurrent: %v", err)
	}
	if tz != "" {
		t.Errorf("expected empty string on empty table, got %q", tz)
	}
}

func TestRecordTimezone_InsertAndRetrieve(t *testing.T) {
	r := setupTZRepo(t)

	if err := r.Record("Europe/Berlin"); err != nil {
		t.Fatalf("Record: %v", err)
	}

	tz, err := r.GetCurrent()
	if err != nil {
		t.Fatalf("GetCurrent: %v", err)
	}
	if tz != "Europe/Berlin" {
		t.Errorf("expected Europe/Berlin, got %q", tz)
	}
}

func TestGetCurrentTimezone_MostRecentReturned(t *testing.T) {
	r := setupTZRepo(t)

	if err := r.Record("America/New_York"); err != nil {
		t.Fatal(err)
	}
	if err := r.Record("Asia/Tokyo"); err != nil {
		t.Fatal(err)
	}
	if err := r.Record("Europe/Berlin"); err != nil {
		t.Fatal(err)
	}

	tz, err := r.GetCurrent()
	if err != nil {
		t.Fatalf("GetCurrent: %v", err)
	}
	if tz != "Europe/Berlin" {
		t.Errorf("expected most recent Europe/Berlin, got %q", tz)
	}
}
