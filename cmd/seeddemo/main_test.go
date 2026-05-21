package main

import (
	"bytes"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// runOnce drives the CLI entry point with the given args, returning the exit
// code and stderr buffer for assertions.
func runOnce(t *testing.T, args []string) (int, string) {
	t.Helper()
	var buf bytes.Buffer
	code := run(args, &buf)
	return code, buf.String()
}

// tempDBPath returns a path under t.TempDir() suitable for the -db flag.
func tempDBPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "seeddemo.db")
}

// openTempDB opens the file the CLI wrote and returns a raw *sql.DB so the
// test can count rows. The CLI uses storedb.Open which runs migrations on
// first open; reopening here just reuses the existing schema.
func openTempDB(t *testing.T, path string) *sql.DB {
	t.Helper()
	d, err := storedb.Open(path)
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return d.DB
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

// TestRunRequiresUser checks the most common operator misuse.
func TestRunRequiresUser(t *testing.T) {
	code, stderr := runOnce(t, []string{"-db", tempDBPath(t)})
	if code == 0 {
		t.Fatalf("expected non-zero exit when -user is missing; stderr=%q", stderr)
	}
	if !strings.Contains(stderr, "-user is required") {
		t.Errorf("expected stderr to mention missing -user, got %q", stderr)
	}
}

// TestTopUpAndWipeAreMutuallyExclusive guards the documented CLI contract:
// passing both -topup and -wipe explicitly should fail fast with a clear
// message rather than wiping the DB the operator expected to extend.
func TestTopUpAndWipeAreMutuallyExclusive(t *testing.T) {
	dbPath := tempDBPath(t)
	code, stderr := runOnce(t, []string{
		"-user", "12345",
		"-db", dbPath,
		"-topup",
		"-wipe", "true",
	})
	if code == 0 {
		t.Fatalf("expected non-zero exit for -topup + -wipe; stderr=%q", stderr)
	}
	if !strings.Contains(stderr, "not both") {
		t.Errorf("expected stderr to explain the conflict, got %q", stderr)
	}
}

// TestTopUpRejectsInvalidNow guards the -now parser.
func TestTopUpRejectsInvalidNow(t *testing.T) {
	dbPath := tempDBPath(t)
	code, stderr := runOnce(t, []string{
		"-user", "12345",
		"-db", dbPath,
		"-topup",
		"-now", "not-a-timestamp",
	})
	if code == 0 {
		t.Fatalf("expected non-zero exit for invalid -now; stderr=%q", stderr)
	}
	if !strings.Contains(stderr, "RFC3339") {
		t.Errorf("expected stderr to mention RFC3339, got %q", stderr)
	}
}

// TestTopUpAddsRowsThenIdempotent runs -topup against an empty tempdb to
// confirm the CLI wires through to seeddemo.TopUp, then re-runs with the
// same -now and asserts no net new rows in any time-series stream. The
// per-tick PCG seed is derived from -now's calendar day; idempotency
// across two calls at the same -now is therefore the integration-level
// invariant.
func TestTopUpAddsRowsThenIdempotent(t *testing.T) {
	dbPath := tempDBPath(t)
	fixedNow := "2026-05-21T12:00:00Z"
	args := []string{
		"-user", "12345",
		"-db", dbPath,
		"-topup",
		"-now", fixedNow,
		"-seed", "42",
	}

	code, stderr := runOnce(t, args)
	if code != 0 {
		t.Fatalf("first -topup run failed: code=%d stderr=%q", code, stderr)
	}

	db := openTempDB(t, dbPath)
	streams := []string{"vitals_heart", "vitals_spo2", "vitals_stress"}
	first := make(map[string]int, len(streams))
	for _, tbl := range streams {
		first[tbl] = countRows(t, db, tbl)
		if first[tbl] == 0 {
			t.Errorf("first -topup added zero rows to %s; expected backfill", tbl)
		}
	}

	// Re-run with the same -now. The day-after snap for daily streams plus
	// (user_id, date_time) PK + INSERT OR IGNORE for time-series must drive
	// the net delta to zero for the time-series tables; daily tables emit
	// no rows because their day-after snap lands on a future day.
	code, stderr = runOnce(t, args)
	if code != 0 {
		t.Fatalf("second -topup run failed: code=%d stderr=%q", code, stderr)
	}
	for _, tbl := range streams {
		got := countRows(t, db, tbl)
		// Plan allows ≤1 net new row per stream for boundary effects; in
		// practice the seeded-day path emits zero.
		delta := got - first[tbl]
		if delta < 0 {
			t.Errorf("%s shrank across idempotent -topup: %d → %d", tbl, first[tbl], got)
		}
		if delta > 1 {
			t.Errorf("%s grew by %d on idempotent -topup; expected ≤1", tbl, delta)
		}
	}
}
