package store

import (
	"testing"
	"time"
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
