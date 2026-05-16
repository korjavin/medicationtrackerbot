package seeddemo

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// fixedNow anchors the synthetic window so generated rows are reproducible
// regardless of when the test runs.
var fixedNow = time.Date(2026, 5, 5, 12, 0, 0, 0, time.UTC)

func newTestStore(t *testing.T) *store.Store {
	t.Helper()
	s, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New(:memory:): %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func runSeeder(t *testing.T, s *store.Store, opts Options) *Summary {
	t.Helper()
	summary, err := Run(context.Background(), s, opts)
	if err != nil {
		t.Fatalf("seeddemo.Run: %v", err)
	}
	return summary
}

func countRows(t *testing.T, db *sql.DB, table string) int {
	t.Helper()
	var n int
	// #nosec G202 -- table name is from a fixed in-test list.
	if err := db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&n); err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	return n
}

func TestRunSeedsAllDomains(t *testing.T) {
	s := newTestStore(t)
	opts := Options{
		UserID: 12345,
		Days:   90,
		Wipe:   true,
		Seed:   42,
		Now:    fixedNow,
	}
	summary := runSeeder(t, s, opts)

	type expectation struct {
		table string
		min   int
		got   int
	}
	checks := []expectation{
		{"medications", 4, countRows(t, s.DB(), "medications")},
		{"intake_log", 200, countRows(t, s.DB(), "intake_log")},
		{"blood_pressure_readings", 50, countRows(t, s.DB(), "blood_pressure_readings")},
		{"weight_logs", 10, countRows(t, s.DB(), "weight_logs")},
		{"sleep_logs", 60, countRows(t, s.DB(), "sleep_logs")},
		{"food_log", 250, countRows(t, s.DB(), "food_log")},
		{"food_products", 6, countRows(t, s.DB(), "food_products")},
		{"workout_sessions", 30, countRows(t, s.DB(), "workout_sessions")},
		{"workout_exercise_logs", 80, countRows(t, s.DB(), "workout_exercise_logs")},
		{"diary_notes", 10, countRows(t, s.DB(), "diary_notes")},
		{"timezone_history", 3, countRows(t, s.DB(), "timezone_history")},
	}
	for _, c := range checks {
		if c.got < c.min {
			t.Errorf("%s: got %d rows, want at least %d", c.table, c.got, c.min)
		}
	}

	// The Summary returned by Run should match the row counts in the DB.
	if summary.Medications != countRows(t, s.DB(), "medications") {
		t.Errorf("summary.Medications=%d but medications row count=%d",
			summary.Medications, countRows(t, s.DB(), "medications"))
	}
	if summary.BPReadings != countRows(t, s.DB(), "blood_pressure_readings") {
		t.Errorf("summary.BPReadings=%d but BP row count=%d",
			summary.BPReadings, countRows(t, s.DB(), "blood_pressure_readings"))
	}
}

func TestRunIsDeterministic(t *testing.T) {
	opts := Options{
		UserID: 12345,
		Days:   90,
		Wipe:   true,
		Seed:   42,
		Now:    fixedNow,
	}

	first := captureRunSnapshot(t, opts)
	second := captureRunSnapshot(t, opts)

	for tbl, want := range first.counts {
		if got := second.counts[tbl]; got != want {
			t.Errorf("row count for %s differs between runs: first=%d second=%d",
				tbl, want, got)
		}
	}
	if first.firstBPSystolic != second.firstBPSystolic {
		t.Errorf("first BP systolic differs: %d vs %d",
			first.firstBPSystolic, second.firstBPSystolic)
	}
	if first.lastBPSystolic != second.lastBPSystolic {
		t.Errorf("last BP systolic differs: %d vs %d",
			first.lastBPSystolic, second.lastBPSystolic)
	}
}

type runSnapshot struct {
	counts          map[string]int
	firstBPSystolic int
	lastBPSystolic  int
}

func captureRunSnapshot(t *testing.T, opts Options) runSnapshot {
	t.Helper()
	s := newTestStore(t)
	runSeeder(t, s, opts)

	tables := []string{
		"medications",
		"intake_log",
		"blood_pressure_readings",
		"weight_logs",
		"sleep_logs",
		"food_log",
		"food_products",
		"workout_sessions",
		"workout_exercise_logs",
		"diary_notes",
		"timezone_history",
	}
	counts := make(map[string]int, len(tables))
	for _, tbl := range tables {
		counts[tbl] = countRows(t, s.DB(), tbl)
	}

	var firstSys, lastSys int
	if err := s.DB().QueryRow(
		"SELECT systolic FROM blood_pressure_readings ORDER BY measured_at ASC, id ASC LIMIT 1",
	).Scan(&firstSys); err != nil {
		t.Fatalf("query first BP: %v", err)
	}
	if err := s.DB().QueryRow(
		"SELECT systolic FROM blood_pressure_readings ORDER BY measured_at DESC, id DESC LIMIT 1",
	).Scan(&lastSys); err != nil {
		t.Fatalf("query last BP: %v", err)
	}
	return runSnapshot{counts: counts, firstBPSystolic: firstSys, lastBPSystolic: lastSys}
}

func TestRunWipesPreExistingData(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	// Plant a sentinel BP row that the seeder must remove when Wipe=true.
	preExisting := &store.BloodPressure{
		UserID:     12345,
		MeasuredAt: fixedNow.Add(-365 * 24 * time.Hour), // a year before the window
		Systolic:   199,
		Diastolic:  111,
	}
	id, err := s.BP.CreateReading(ctx, preExisting)
	if err != nil {
		t.Fatalf("CreateReading: %v", err)
	}
	if id == 0 {
		t.Fatal("expected non-zero id for pre-existing BP row")
	}

	runSeeder(t, s, Options{
		UserID: 12345,
		Days:   90,
		Wipe:   true,
		Seed:   42,
		Now:    fixedNow,
	})

	var n int
	if err := s.DB().QueryRow(
		"SELECT COUNT(*) FROM blood_pressure_readings WHERE id = ?", id,
	).Scan(&n); err != nil {
		t.Fatalf("count sentinel BP: %v", err)
	}
	if n != 0 {
		t.Fatalf("expected pre-existing BP row to be wiped, found %d row(s)", n)
	}

	// Sanity: the seeder still produced data after the wipe.
	if got := countRows(t, s.DB(), "blood_pressure_readings"); got == 0 {
		t.Fatal("expected seeder to repopulate blood_pressure_readings after wipe")
	}
}
