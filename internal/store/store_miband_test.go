package store

import (
	"database/sql"

	"context"
	"testing"
	"time"
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

// recentMs returns a Unix-millisecond timestamp that is recent enough
// to pass the 90-day filter in ListMiBandWorkouts.
func recentMs(daysAgo int) int64 {
	return time.Now().AddDate(0, 0, -daysAgo).UnixMilli()
}

func TestInsertMiBandWorkout(t *testing.T) {
	db := setupMiBandTestStore(t)
	ctx := context.Background()
	userID := int64(42)

	w := &MiBandWorkout{
		UserID:        userID,
		SourceStartMs: recentMs(5),
		SourceEndMs:   recentMs(5) + 3600000,
		ActivityType:  12,
		ActivityName:  "running",
		DurationSec:   3600,
		DistanceM:     5000,
		Steps:         6000,
		Calories:      350,
		HeartRateAvg:  145,
	}

	// First insert should succeed
	inserted, err := db.InsertMiBandWorkout(ctx, w)
	if err != nil {
		t.Fatalf("InsertMiBandWorkout: %v", err)
	}
	if !inserted {
		t.Error("expected first insert to return true")
	}
	if w.ID == 0 {
		t.Error("expected ID to be set")
	}

	// Second insert of same data should be deduplicated
	inserted, err = db.InsertMiBandWorkout(ctx, w)
	if err != nil {
		t.Fatalf("InsertMiBandWorkout (duplicate): %v", err)
	}
	if inserted {
		t.Error("expected second insert to return false (dedup)")
	}

	// Verify retrieval
	result, err := db.ListMiBandWorkouts(ctx, userID, 10)
	if err != nil {
		t.Fatalf("ListMiBandWorkouts: %v", err)
	}
	if len(result) != 1 {
		t.Fatalf("expected 1 workout, got %d", len(result))
	}
	if result[0].ActivityName != "running" {
		t.Errorf("expected running, got %s", result[0].ActivityName)
	}
	if result[0].DistanceM != 5000 {
		t.Errorf("expected distance 5000, got %f", result[0].DistanceM)
	}
}

func TestImportMiBandWorkouts_Basic(t *testing.T) {
	db := setupMiBandTestStore(t)
	ctx := context.Background()
	userID := int64(42)

	workouts := []MiBandWorkout{
		{
			UserID:        userID,
			SourceStartMs: recentMs(5),
			SourceEndMs:   recentMs(5) + 7200000,
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
			SourceStartMs: recentMs(3),
			SourceEndMs:   recentMs(3) + 7715000,
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
			SourceStartMs: recentMs(10),
			SourceEndMs:   recentMs(10) + 3600000,
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

	startMs := recentMs(7)
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

	startMs := recentMs(2)
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

func TestDeleteMiBandWorkout(t *testing.T) {
	db := setupMiBandTestStore(t)
	ctx := context.Background()
	userID := int64(42)
	otherUserID := int64(43)

	startMs := recentMs(2)
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

	if _, _, err := db.ImportMiBandWorkouts(ctx, workouts, gps); err != nil {
		t.Fatalf("import: %v", err)
	}

	result, _ := db.ListMiBandWorkouts(ctx, userID, 1)
	if len(result) != 1 {
		t.Fatalf("expected 1 workout, got %d", len(result))
	}
	workoutID := result[0].ID

	// Try deleting with wrong user ID
	err := db.DeleteMiBandWorkout(ctx, workoutID, otherUserID)
	if err != sql.ErrNoRows {
		t.Errorf("expected ErrNoRows when deleting with wrong user ID, got %v", err)
	}

	// Delete with correct user ID
	err = db.DeleteMiBandWorkout(ctx, workoutID, userID)
	if err != nil {
		t.Errorf("expected nil error on successful delete, got %v", err)
	}

	// Verify workout is gone
	w, err := db.GetMiBandWorkout(ctx, workoutID)
	if err != nil {
		t.Fatalf("unexpected error fetching deleted workout: %v", err)
	}
	if w != nil {
		t.Errorf("expected nil workout, got %+v", w)
	}

	// Verify GPS track is also gone (cascade)
	pts, err := db.GetMiBandWorkoutGPS(ctx, workoutID)
	if err != nil {
		t.Fatalf("unexpected error fetching GPS for deleted workout: %v", err)
	}
	if len(pts) != 0 {
		t.Errorf("expected 0 GPS points after cascade delete, got %d", len(pts))
	}
}

func TestUpdateMiBandWorkout(t *testing.T) {
	db := setupMiBandTestStore(t)
	ctx := context.Background()
	userID := int64(42)

	startMs := recentMs(2)
	workouts := []MiBandWorkout{
		{
			UserID: userID, SourceStartMs: startMs, SourceEndMs: startMs + 1000000,
			ActivityType: 12, ActivityName: "cycling", DurationSec: 1000, DistanceM: 8000,
			Steps: 0, Calories: 500, HeartRateAvg: 120, SpO2Avg: 95,
		},
	}

	if _, _, err := db.ImportMiBandWorkouts(ctx, workouts, nil); err != nil {
		t.Fatalf("import: %v", err)
	}

	result, _ := db.ListMiBandWorkouts(ctx, userID, 1)
	if len(result) != 1 {
		t.Fatalf("expected 1 workout, got %d", len(result))
	}
	workoutID := result[0].ID

	// Update single field
	newSteps := 5000
	err := db.UpdateMiBandWorkout(ctx, workoutID, userID, UpdateMiBandWorkoutFields{
		Steps: &newSteps,
	})
	if err != nil {
		t.Errorf("unexpected error updating single field: %v", err)
	}

	w, _ := db.GetMiBandWorkout(ctx, workoutID)
	if w.Steps != newSteps {
		t.Errorf("expected %d steps, got %d", newSteps, w.Steps)
	}
	// Verify other fields didn't change
	if w.DistanceM != 8000 {
		t.Errorf("expected distance to remain 8000, got %v", w.DistanceM)
	}

	// Update multiple fields
	newDist := 8500.5
	newDur := 1100
	newCal := 600
	newHR := 125
	newSpO2 := 96

	err = db.UpdateMiBandWorkout(ctx, workoutID, userID, UpdateMiBandWorkoutFields{
		DistanceM:    &newDist,
		DurationSec:  &newDur,
		Calories:     &newCal,
		HeartRateAvg: &newHR,
		SpO2Avg:      &newSpO2,
	})
	if err != nil {
		t.Errorf("unexpected error updating multiple fields: %v", err)
	}

	w, _ = db.GetMiBandWorkout(ctx, workoutID)
	if w.DistanceM != newDist || w.DurationSec != newDur || w.Calories != newCal || w.HeartRateAvg != newHR || w.SpO2Avg != newSpO2 {
		t.Errorf("multiple field update failed. got: %+v", w)
	}
	// Verify steps wasn't overwritten by nil pointer
	if w.Steps != newSteps {
		t.Errorf("expected steps to remain %d, got %d", newSteps, w.Steps)
	}

	// Update non-existent
	err = db.UpdateMiBandWorkout(ctx, 99999, userID, UpdateMiBandWorkoutFields{Steps: &newSteps})
	if err != sql.ErrNoRows {
		t.Errorf("expected ErrNoRows updating non-existent workout, got %v", err)
	}

	// Update wrong user
	err = db.UpdateMiBandWorkout(ctx, workoutID, 99, UpdateMiBandWorkoutFields{Steps: &newSteps})
	if err != sql.ErrNoRows {
		t.Errorf("expected ErrNoRows updating with wrong user ID, got %v", err)
	}
}
