package domain

import (
	"context"
	"database/sql"
	"os"
	"testing"

	_ "modernc.org/sqlite"
)

// createMiBandTestDB creates a temporary SQLite file with the workout + gps tables
// populated with test data, and returns the file path.
// The caller is responsible for removing the file.
func createMiBandTestDB(t *testing.T, workouts []struct {
	startMs, endMs                            int64
	typ                                       int
	distance, steps, calories, heartAvg, spo2 int
	pauseMs, tz                               int
}, gpsPoints []struct {
	tsMs          int64
	lat, lon, alt float64
	pause         int
}) string {
	t.Helper()

	f, err := os.CreateTemp("", "miband-test-*.db")
	if err != nil {
		t.Fatalf("create temp db: %v", err)
	}
	_ = f.Close()
	t.Cleanup(func() { _ = os.Remove(f.Name()) }) // #nosec G104

	db, err := sql.Open("sqlite", f.Name())
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	defer db.Close()

	_, err = db.ExecContext(context.Background(), `
		CREATE TABLE workout (
			startDateTime INTEGER,
			endDateTime   INTEGER,
			type          INTEGER,
			distance      REAL,
			steps         INTEGER,
			calories      INTEGER,
			heartAvg      INTEGER,
			spo2Avg       INTEGER,
			pause         INTEGER,
			tz            INTEGER
		);
		CREATE TABLE gps (
			dateTime  INTEGER,
			latitude  REAL,
			longitude REAL,
			altitude  REAL,
			speed     REAL,
			pause     INTEGER
		);
	`)
	if err != nil {
		t.Fatalf("create schema: %v", err)
	}

	for _, w := range workouts {
		_, err := db.ExecContext(context.Background(),
			`INSERT INTO workout VALUES (?,?,?,?,?,?,?,?,?,?)`,
			w.startMs, w.endMs, w.typ, w.distance, w.steps,
			w.calories, w.heartAvg, w.spo2, w.pauseMs, w.tz,
		)
		if err != nil {
			t.Fatalf("insert workout: %v", err)
		}
	}

	for _, g := range gpsPoints {
		_, err := db.ExecContext(context.Background(),
			`INSERT INTO gps VALUES (?,?,?,?,0,?)`,
			g.tsMs, g.lat, g.lon, g.alt, g.pause,
		)
		if err != nil {
			t.Fatalf("insert gps: %v", err)
		}
	}

	return f.Name()
}

func TestParseOutdoorWorkouts_TypeFiltering(t *testing.T) {
	// Types 12 (cycling) and 80 (nordic walking) should be included.
	// Type 54 (strength) should be excluded.
	// Only workouts with distance > 0 should be included.
	dbPath := createMiBandTestDB(t,
		[]struct {
			startMs, endMs                            int64
			typ                                       int
			distance, steps, calories, heartAvg, spo2 int
			pauseMs, tz                               int
		}{
			{1000000, 1003600000, 12, 8500, 0, 320, 135, 0, 0, 60},    // cycling ✓
			{2000000, 2005000000, 80, 7200, 6500, 850, 118, 0, 0, 60}, // nordic walking ✓
			{3000000, 3002000000, 54, 0, 1200, 200, 100, 0, 0, 60},    // strength, distance=0 ✗
			{4000000, 4001000000, 3, 3000, 3800, 0, 125, 0, 0, 60},    // walking ✓
		},
		nil,
	)

	workouts, gpsTracks, err := ParseOutdoorWorkouts(dbPath)
	if err != nil {
		t.Fatalf("ParseOutdoorWorkouts: %v", err)
	}

	if len(workouts) != 3 {
		t.Fatalf("expected 3 outdoor workouts, got %d", len(workouts))
	}
	// nil map is fine — no GPS data was added
	_ = gpsTracks

	// Verify activity names are mapped correctly
	nameByType := map[int]string{}
	for _, w := range workouts {
		nameByType[w.ActivityType] = w.ActivityName
	}
	if nameByType[12] != "cycling" {
		t.Errorf("type 12: expected 'cycling', got %q", nameByType[12])
	}
	if nameByType[80] != "nordic_walking" {
		t.Errorf("type 80: expected 'nordic_walking', got %q", nameByType[80])
	}
	if nameByType[3] != "walking" {
		t.Errorf("type 3: expected 'walking', got %q", nameByType[3])
	}
	if _, has54 := nameByType[54]; has54 {
		t.Error("type 54 (strength) should not be in results")
	}
}

func TestParseOutdoorWorkouts_DurationCalculation(t *testing.T) {
	// Duration must be computed from (endMs - startMs) / 1000,
	// not from the unreliable 'duration' field.
	startMs := int64(1700000000000) // arbitrary timestamp
	endMs := startMs + 7200*1000    // exactly 2 hours later

	dbPath := createMiBandTestDB(t,
		[]struct {
			startMs, endMs                            int64
			typ                                       int
			distance, steps, calories, heartAvg, spo2 int
			pauseMs, tz                               int
		}{
			{startMs, endMs, 12, 10000, 0, 500, 140, 0, 0, 60},
		},
		nil,
	)

	workouts, _, err := ParseOutdoorWorkouts(dbPath)
	if err != nil {
		t.Fatalf("ParseOutdoorWorkouts: %v", err)
	}
	if len(workouts) != 1 {
		t.Fatalf("expected 1 workout, got %d", len(workouts))
	}

	expectedSec := 7200
	if workouts[0].DurationSec != expectedSec {
		t.Errorf("DurationSec = %d, want %d", workouts[0].DurationSec, expectedSec)
	}
}

func TestParseOutdoorWorkouts_GPSAssignment(t *testing.T) {
	// Two workouts with a gap between them.
	// GPS points should be assigned to the correct workout based on timestamp.
	w1Start := int64(1000000)
	w1End := int64(2000000)
	w2Start := int64(3000000) // gap: 2000001–2999999
	w2End := int64(4000000)

	gpsPoints := []struct {
		tsMs          int64
		lat, lon, alt float64
		pause         int
	}{
		{1100000, 52.1, 13.1, 50.0, 0}, // → workout 1
		{1500000, 52.2, 13.2, 51.0, 0}, // → workout 1
		{2500000, 52.5, 13.5, 55.0, 0}, // → gap, should be skipped
		{3100000, 53.0, 14.0, 60.0, 0}, // → workout 2
		{3800000, 53.1, 14.1, 61.0, 0}, // → workout 2
	}

	dbPath := createMiBandTestDB(t,
		[]struct {
			startMs, endMs                            int64
			typ                                       int
			distance, steps, calories, heartAvg, spo2 int
			pauseMs, tz                               int
		}{
			{w1Start, w1End, 12, 8000, 0, 400, 138, 0, 0, 0},
			{w2Start, w2End, 80, 5000, 5000, 600, 115, 0, 0, 0},
		},
		gpsPoints,
	)

	workouts, gpsTracks, err := ParseOutdoorWorkouts(dbPath)
	if err != nil {
		t.Fatalf("ParseOutdoorWorkouts: %v", err)
	}
	if len(workouts) != 2 {
		t.Fatalf("expected 2 workouts, got %d", len(workouts))
	}

	w1GPS := gpsTracks[w1Start]
	w2GPS := gpsTracks[w2Start]

	if len(w1GPS) != 2 {
		t.Errorf("workout 1: expected 2 GPS points, got %d", len(w1GPS))
	}
	if len(w2GPS) != 2 {
		t.Errorf("workout 2: expected 2 GPS points, got %d", len(w2GPS))
	}

	// Verify the gap point (ts=2500000) was not assigned to either workout
	for k, pts := range gpsTracks {
		for _, pt := range pts {
			if pt.TsMs == 2500000 {
				t.Errorf("gap GPS point (ts=2500000) was incorrectly assigned to workout key %d", k)
			}
		}
	}
}

func TestParseOutdoorWorkouts_Empty(t *testing.T) {
	// Database with no matching workouts should return empty slice, not error.
	dbPath := createMiBandTestDB(t,
		[]struct {
			startMs, endMs                            int64
			typ                                       int
			distance, steps, calories, heartAvg, spo2 int
			pauseMs, tz                               int
		}{
			{1000000, 2000000, 54, 0, 2000, 300, 120, 0, 0, 0}, // strength only
		},
		nil,
	)

	workouts, _, err := ParseOutdoorWorkouts(dbPath)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(workouts) != 0 {
		t.Errorf("expected 0 workouts, got %d", len(workouts))
	}
}
