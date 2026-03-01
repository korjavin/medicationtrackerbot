package store

import (
	"context"
	"testing"
)

func setupMiBandTestStore(t *testing.T) *Store {
	t.Helper()
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("create test store: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestImportMiBandWorkouts_Basic(t *testing.T) {
	db := setupMiBandTestStore(t)
	ctx := context.Background()
	userID := int64(42)

	workouts := []MiBandWorkout{
		{
			UserID:        userID,
			SourceStartMs: 1700000000000,
			SourceEndMs:   1700007200000,
			ActivityType:  12,
			ActivityName:  "cycling",
			DurationSec:   7200,
			DistanceM:     28000,
			Steps:         0,
			Calories:      850,
			HeartRateAvg:  140,
		},
		{
			UserID:        userID,
			SourceStartMs: 1700100000000,
			SourceEndMs:   1700107715000,
			ActivityType:  80,
			ActivityName:  "nordic_walking",
			DurationSec:   7715,
			DistanceM:     7433,
			Steps:         6476,
			Calories:      1672,
			HeartRateAvg:  117,
		},
	}

	imported, skipped, err := db.ImportMiBandWorkouts(ctx, workouts, nil)
	if err != nil {
		t.Fatalf("ImportMiBandWorkouts: %v", err)
	}
	if imported != 2 {
		t.Errorf("expected 2 imported, got %d", imported)
	}
	if skipped != 0 {
		t.Errorf("expected 0 skipped, got %d", skipped)
	}

	// Verify retrieval
	result, err := db.ListMiBandWorkouts(ctx, userID, 10)
	if err != nil {
		t.Fatalf("ListMiBandWorkouts: %v", err)
	}
	if len(result) != 2 {
		t.Fatalf("expected 2 workouts, got %d", len(result))
	}

	// ListMiBandWorkouts returns newest first (ORDER BY source_start_ms DESC)
	if result[0].ActivityName != "nordic_walking" {
		t.Errorf("expected first result to be nordic_walking, got %q", result[0].ActivityName)
	}
	if result[1].ActivityName != "cycling" {
		t.Errorf("expected second result to be cycling, got %q", result[1].ActivityName)
	}
	if result[1].DistanceM != 28000 {
		t.Errorf("expected cycling distance 28000, got %v", result[1].DistanceM)
	}
}

func TestImportMiBandWorkouts_Deduplication(t *testing.T) {
	// Importing the same backup twice must not create duplicates.
	db := setupMiBandTestStore(t)
	ctx := context.Background()
	userID := int64(42)

	workouts := []MiBandWorkout{
		{
			UserID:        userID,
			SourceStartMs: 1700000000000,
			SourceEndMs:   1700003600000,
			ActivityType:  12,
			ActivityName:  "cycling",
			DurationSec:   3600,
			DistanceM:     15000,
		},
	}

	// First import
	imported, skipped, err := db.ImportMiBandWorkouts(ctx, workouts, nil)
	if err != nil {
		t.Fatalf("first import: %v", err)
	}
	if imported != 1 {
		t.Errorf("first import: expected 1 imported, got %d", imported)
	}
	if skipped != 0 {
		t.Errorf("first import: expected 0 skipped, got %d", skipped)
	}

	// Second import of same data
	imported, skipped, err = db.ImportMiBandWorkouts(ctx, workouts, nil)
	if err != nil {
		t.Fatalf("second import: %v", err)
	}
	if imported != 0 {
		t.Errorf("second import: expected 0 imported (duplicate), got %d", imported)
	}
	if skipped != 1 {
		t.Errorf("second import: expected 1 skipped (duplicate), got %d", skipped)
	}

	// Only 1 record in DB
	result, err := db.ListMiBandWorkouts(ctx, userID, 10)
	if err != nil {
		t.Fatalf("ListMiBandWorkouts: %v", err)
	}
	if len(result) != 1 {
		t.Errorf("expected 1 workout after dedup, got %d", len(result))
	}
}

func TestImportMiBandWorkouts_WithGPS(t *testing.T) {
	db := setupMiBandTestStore(t)
	ctx := context.Background()
	userID := int64(42)

	startMs := int64(1700000000000)
	workouts := []MiBandWorkout{
		{
			UserID:        userID,
			SourceStartMs: startMs,
			SourceEndMs:   startMs + 3600000,
			ActivityType:  80,
			ActivityName:  "nordic_walking",
			DurationSec:   3600,
			DistanceM:     4500,
		},
	}
	gpsPoints := map[int64][]MiBandGPSPoint{
		startMs: {
			{TsMs: startMs + 10000, Latitude: 52.1, Longitude: 13.1, Altitude: 50.0, IsPause: false},
			{TsMs: startMs + 20000, Latitude: 52.2, Longitude: 13.2, Altitude: 51.0, IsPause: false},
			{TsMs: startMs + 30000, Latitude: 52.3, Longitude: 13.3, Altitude: 52.0, IsPause: true},
		},
	}

	imported, _, err := db.ImportMiBandWorkouts(ctx, workouts, gpsPoints)
	if err != nil {
		t.Fatalf("ImportMiBandWorkouts with GPS: %v", err)
	}
	if imported != 1 {
		t.Fatalf("expected 1 imported, got %d", imported)
	}

	// Fetch the workout to get its ID
	result, err := db.ListMiBandWorkouts(ctx, userID, 1)
	if err != nil || len(result) != 1 {
		t.Fatalf("ListMiBandWorkouts: %v (len=%d)", err, len(result))
	}
	workoutID := result[0].ID

	// Fetch GPS track
	pts, err := db.GetMiBandWorkoutGPS(ctx, workoutID)
	if err != nil {
		t.Fatalf("GetMiBandWorkoutGPS: %v", err)
	}
	if len(pts) != 3 {
		t.Fatalf("expected 3 GPS points, got %d", len(pts))
	}

	// Verify order and pause flag
	if pts[0].Latitude != 52.1 {
		t.Errorf("first point: expected lat 52.1, got %v", pts[0].Latitude)
	}
	if pts[2].IsPause != true {
		t.Errorf("third point: expected IsPause=true, got %v", pts[2].IsPause)
	}
}

func TestImportMiBandWorkouts_GPSNotDuplicatedOnReimport(t *testing.T) {
	// GPS tracks should not be inserted twice when re-importing the same backup.
	db := setupMiBandTestStore(t)
	ctx := context.Background()
	userID := int64(42)

	startMs := int64(1700000000000)
	workouts := []MiBandWorkout{
		{
			UserID: userID, SourceStartMs: startMs, SourceEndMs: startMs + 1000000,
			ActivityType: 12, ActivityName: "cycling", DurationSec: 1000, DistanceM: 8000,
		},
	}
	gps := map[int64][]MiBandGPSPoint{
		startMs: {
			{TsMs: startMs + 100, Latitude: 51.0, Longitude: 12.0, Altitude: 40.0},
		},
	}

	// First import
	if _, _, err := db.ImportMiBandWorkouts(ctx, workouts, gps); err != nil {
		t.Fatalf("first import: %v", err)
	}

	// Second import: workout is skipped, GPS must not be re-inserted
	if _, _, err := db.ImportMiBandWorkouts(ctx, workouts, gps); err != nil {
		t.Fatalf("second import: %v", err)
	}

	result, _ := db.ListMiBandWorkouts(ctx, userID, 1)
	if len(result) != 1 {
		t.Fatalf("expected 1 workout, got %d", len(result))
	}
	pts, err := db.GetMiBandWorkoutGPS(ctx, result[0].ID)
	if err != nil {
		t.Fatalf("GetMiBandWorkoutGPS: %v", err)
	}
	if len(pts) != 1 {
		t.Errorf("expected 1 GPS point after re-import (no duplicates), got %d", len(pts))
	}
}

func TestGetMiBandWorkout_NotFound(t *testing.T) {
	db := setupMiBandTestStore(t)
	ctx := context.Background()

	result, err := db.GetMiBandWorkout(ctx, 99999)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != nil {
		t.Errorf("expected nil for non-existent workout, got %+v", result)
	}
}
