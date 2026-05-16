package store

import (
	"database/sql"
	"testing"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	_ "modernc.org/sqlite"
)

// TestTimeUnixUTCRoundTrip pins the invariant that any wall-clock time, regardless
// of its time.Location, round-trips losslessly through unix seconds when stored as
// INTEGER and read back via time.Unix(n, 0).UTC(). This is the primitive that makes
// the new intake_log dose-time columns (scheduled_at_unix, taken_at_unix,
// snoozed_until_unix) immune to the TZ-name equality bug class (see
// docs/plans/2026-05-10-intake-log-utc-unix-fix.md).
func TestTimeUnixUTCRoundTrip(t *testing.T) {
	berlin, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatalf("load Europe/Berlin: %v", err)
	}
	la, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatalf("load America/Los_Angeles: %v", err)
	}
	phoenix, err := time.LoadLocation("America/Phoenix")
	if err != nil {
		t.Fatalf("load America/Phoenix: %v", err)
	}

	cases := []struct {
		name string
		t    time.Time
	}{
		{"UTC", time.Date(2026, 5, 10, 15, 20, 0, 0, time.UTC)},
		{"Europe/Berlin CEST", time.Date(2026, 5, 10, 17, 20, 0, 0, berlin)},
		{"America/Los_Angeles PDT", time.Date(2026, 5, 10, 8, 20, 0, 0, la)},
		{"America/Phoenix MST", time.Date(2026, 5, 10, 8, 20, 0, 0, phoenix)},
		{"Europe/Berlin CET (winter)", time.Date(2026, 1, 15, 9, 0, 0, 0, berlin)},
		{"America/Los_Angeles PST (winter)", time.Date(2026, 1, 15, 9, 0, 0, 0, la)},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			n := tc.t.UTC().Unix()
			got := time.Unix(n, 0).UTC()
			if !got.Equal(tc.t) {
				t.Errorf("round-trip mismatch: original=%s (unix=%d), got=%s (unix=%d)",
					tc.t.Format(time.RFC3339Nano), tc.t.Unix(),
					got.Format(time.RFC3339Nano), got.Unix())
			}
			if got.Location() != time.UTC {
				t.Errorf("round-trip location should be UTC, got %v", got.Location())
			}
		})
	}
}

// TestTimeUnixUTCSameInstantDifferentZones asserts that two time.Time values
// representing the same absolute instant in different time.Locations produce the
// same unix seconds — which is what makes the new SQL equality predicate
// (WHERE scheduled_at_unix = ?) unambiguous regardless of caller TZ. This is the
// today-incident encoded as a unit test: 2026-05-10 08:20 PDT and 2026-05-10
// 08:20 MST are the same instant (15:20 UTC) and must compare equal as unix.
func TestTimeUnixUTCSameInstantDifferentZones(t *testing.T) {
	la, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatalf("load America/Los_Angeles: %v", err)
	}
	phoenix, err := time.LoadLocation("America/Phoenix")
	if err != nil {
		t.Fatalf("load America/Phoenix: %v", err)
	}

	inLA := time.Date(2026, 5, 10, 8, 20, 0, 0, la)
	inPhoenix := time.Date(2026, 5, 10, 8, 20, 0, 0, phoenix)

	if inLA.Unix() != inPhoenix.Unix() {
		t.Fatalf("expected same unix seconds for the same absolute instant, got LA=%d Phoenix=%d",
			inLA.Unix(), inPhoenix.Unix())
	}
}

// TestTimeUnixUTCStripsMonotonic ensures that time.Now()'s monotonic-clock residue
// (which has been observed leaking through t.String() into prod DB rows) does not
// survive the UTC().Unix() write boundary. Reading back via time.Unix yields a
// wall-clock-only value that compares correctly with a freshly constructed time.
func TestTimeUnixUTCStripsMonotonic(t *testing.T) {
	now := time.Now()
	n := now.UTC().Unix()
	roundTripped := time.Unix(n, 0).UTC()
	if !roundTripped.Equal(now) {
		// Allow up to 1 second drift since we truncate to seconds.
		drift := now.Sub(roundTripped)
		if drift < -time.Second || drift > time.Second {
			t.Errorf("unexpected drift: now=%s, roundTripped=%s, drift=%s",
				now.Format(time.RFC3339Nano),
				roundTripped.Format(time.RFC3339Nano),
				drift)
		}
	}
	// The round-tripped value must have a zero monotonic component — it was
	// constructed via time.Unix, which never carries one. This is the property
	// the production write path now relies on.
	if roundTripped.Round(0) != roundTripped {
		t.Errorf("round-tripped time unexpectedly carries monotonic clock data: %v", roundTripped)
	}
}

// TestDoseTimeColumnsAreInteger is the cross-table architecture test that
// pins the convention documented in the package comment at the top of
// store.go and in docs/architecture.md → "Time storage": every dose-related
// time column across the schema must be declared INTEGER (unix seconds, UTC),
// and the pre-2026-05 legacy text-typed (DATETIME) columns must not survive.
//
// The allowlist below is the audit anchor — readers can grep one place to see
// which columns are unix-seconds. Non-dose DATETIME columns (workouts, BP,
// weight, sleep) are deliberately untouched: this test has no opinion about
// them. A future migration that regresses any allowlisted column to TEXT, or
// resurrects any forbidden legacy column, fails CI loudly.
//
// Per-table allowlist tests live alongside the owning package
// (medication/time_columns_test.go for intake_log); this top-level test is
// the single canonical list that spans every table touched by Tasks 2/5/6/7
// of the simplify-medication-scheduling plan.
func TestDoseTimeColumnsAreInteger(t *testing.T) {
	d, err := storedb.Open(":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })

	if err := d.Migrate(embedMigrations, "migrations"); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	type tableSpec struct {
		table         string
		required      []string // columns that must exist and be INTEGER
		forbiddenText []string // columns that must not exist (legacy DATETIME shape)
	}
	specs := []tableSpec{
		{
			table: "intake_log",
			required: []string{
				"scheduled_at_unix",
				"taken_at_unix",
				"snoozed_until_unix",
			},
			forbiddenText: []string{
				"scheduled_at",
				"taken_at",
				"snoozed_until",
			},
		},
		{
			table: "tz_transition_plans",
			required: []string{
				"created_at_unix",
				"notified_at_unix",
				"approved_at_unix",
			},
			forbiddenText: []string{
				"created_at",
				"notified_at",
				"approved_at",
			},
		},
	}

	for _, spec := range specs {
		t.Run(spec.table, func(t *testing.T) {
			types := pragmaTableInfo(t, d.DB, spec.table)

			for _, col := range spec.required {
				ctype, ok := types[col]
				if !ok {
					t.Errorf("%s.%s: required dose-time column is missing — schema must declare it as INTEGER unix-seconds-UTC (see store.go package comment / docs/architecture.md → Time storage)", spec.table, col)
					continue
				}
				if ctype != "INTEGER" {
					t.Errorf("%s.%s: declared type=%q, want %q — dose-time columns must be INTEGER unix-seconds-UTC", spec.table, col, ctype, "INTEGER")
				}
			}

			for _, col := range spec.forbiddenText {
				if ctype, ok := types[col]; ok {
					t.Errorf("%s.%s: legacy text-typed column survived (declared type=%q). It must be dropped by a table-rebuild migration; readers must use %s_unix instead.", spec.table, col, ctype, col)
				}
			}
		})
	}
}

// pragmaTableInfo returns a map of column name → declared type for the given
// table, sourced from SQLite's PRAGMA table_info. Used by the dose-time-column
// architecture test above.
func pragmaTableInfo(t *testing.T, db *sql.DB, table string) map[string]string {
	t.Helper()
	rows, err := db.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		t.Fatalf("PRAGMA table_info(%s): %v", table, err)
	}
	defer rows.Close()
	types := map[string]string{}
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			t.Fatalf("scan pragma row for %s: %v", table, err)
		}
		types[name] = ctype
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows err for %s: %v", table, err)
	}
	return types
}
