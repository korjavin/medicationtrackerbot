package workout

import (
	"context"
	"database/sql"
	"testing"
	"time"
)

func setupMiBandTestStore(t *testing.T) *Repo {
	return setupTestDB(t)
}

// recentMs returns a Unix-millisecond timestamp that is recent enough
// to pass the 90-day filter in ListMiBand.
func recentMs(daysAgo int) int64 {
	return time.Now().AddDate(0, 0, -daysAgo).UnixMilli()
}

func TestInsertMiBand(t *testing.T) {
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
	inserted, err := db.InsertMiBand(ctx, w)
	if err != nil {
		t.Fatalf("InsertMiBand: %v", err)
	}
	if !inserted {
		t.Error("expected first insert to return true")
	}
	if w.ID == 0 {
		t.Error("expected ID to be set")
	}

	// Second insert of same data should be deduplicated
	inserted, err = db.InsertMiBand(ctx, w)
	if err != nil {
		t.Fatalf("InsertMiBand (duplicate): %v", err)
	}
	if inserted {
		t.Error("expected second insert to return false (dedup)")
	}

	// Verify retrieval
	result, err := db.ListMiBand(ctx, userID, 10)
	if err != nil {
		t.Fatalf("ListMiBand: %v", err)
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

func TestImportMiBand_Basic(t *testing.T) {
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

	imported, skipped, err := db.ImportMiBand(ctx, workouts, nil)
	if err != nil {
		t.Fatalf("ImportMiBand: %v", err)
	}
	if imported != 2 {
		t.Errorf("expected 2 imported, got %d", imported)
	}
	if skipped != 0 {
		t.Errorf("expected 0 skipped, got %d", skipped)
	}

	// Verify retrieval
	result, err := db.ListMiBand(ctx, userID, 10)
	if err != nil {
		t.Fatalf("ListMiBand: %v", err)
	}
	if len(result) != 2 {
		t.Fatalf("expected 2 workouts, got %d", len(result))
	}

	// ListMiBand returns newest first (ORDER BY source_start_ms DESC)
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

func TestImportMiBand_Deduplication(t *testing.T) {
	// Importing the same backup twice must not create duplicate rows.
	// With UPSERT, the second import updates the existing row (counted as imported).
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
	imported, skipped, err := db.ImportMiBand(ctx, workouts, nil)
	if err != nil {
		t.Fatalf("first import: %v", err)
	}
	if imported != 1 {
		t.Errorf("first import: expected 1 imported, got %d", imported)
	}
	if skipped != 0 {
		t.Errorf("first import: expected 0 skipped, got %d", skipped)
	}

	// Second import of same data — exact replay reports the record as existing (skipped).
	imported, skipped, err = db.ImportMiBand(ctx, workouts, nil)
	if err != nil {
		t.Fatalf("second import: %v", err)
	}
	if imported != 0 {
		t.Errorf("second import: expected 0 imported (replay), got %d", imported)
	}
	if skipped != 1 {
		t.Errorf("second import: expected 1 skipped (existing record), got %d", skipped)
	}

	// Only 1 record in DB (no duplicates)
	result, err := db.ListMiBand(ctx, userID, 10)
	if err != nil {
		t.Fatalf("ListMiBand: %v", err)
	}
	if len(result) != 1 {
		t.Errorf("expected 1 workout after dedup, got %d", len(result))
	}
}

func TestInsertMiBand_UpsertUpdatesFields(t *testing.T) {
	db := setupMiBandTestStore(t)
	ctx := context.Background()
	userID := int64(42)
	startMs := recentMs(5)

	w := &MiBandWorkout{
		UserID:        userID,
		SourceStartMs: startMs,
		SourceEndMs:   startMs + 3600000,
		ActivityType:  12,
		ActivityName:  "running",
		DurationSec:   3600,
		DistanceM:     3000,
		Steps:         1000,
		Calories:      200,
		HeartRateAvg:  130,
	}

	// First insert
	inserted, err := db.InsertMiBand(ctx, w)
	if err != nil {
		t.Fatalf("first insert: %v", err)
	}
	if !inserted {
		t.Error("expected first insert to return true")
	}
	firstID := w.ID

	// Second insert with updated values
	w2 := &MiBandWorkout{
		UserID:        userID,
		SourceStartMs: startMs,
		SourceEndMs:   startMs + 7200000,
		ActivityType:  12,
		ActivityName:  "running",
		DurationSec:   7200,
		DistanceM:     8000,
		Steps:         5000,
		Calories:      500,
		HeartRateAvg:  145,
	}
	inserted, err = db.InsertMiBand(ctx, w2)
	if err != nil {
		t.Fatalf("second insert: %v", err)
	}
	if inserted {
		t.Error("expected second insert to return false (update, not new)")
	}

	// Verify the row was updated
	result, err := db.ListMiBand(ctx, userID, 10)
	if err != nil {
		t.Fatalf("ListMiBand: %v", err)
	}
	if len(result) != 1 {
		t.Fatalf("expected 1 workout, got %d", len(result))
	}
	if result[0].Steps != 5000 {
		t.Errorf("expected steps=5000 after upsert, got %d", result[0].Steps)
	}
	if result[0].DistanceM != 8000 {
		t.Errorf("expected distance=8000 after upsert, got %f", result[0].DistanceM)
	}
	if result[0].Calories != 500 {
		t.Errorf("expected calories=500 after upsert, got %d", result[0].Calories)
	}
	if result[0].ID != firstID {
		t.Errorf("expected ID to remain %d, got %d", firstID, result[0].ID)
	}
}

func TestImportMiBand_UpsertUpdatesFields(t *testing.T) {
	db := setupMiBandTestStore(t)
	ctx := context.Background()
	userID := int64(42)
	startMs := recentMs(5)

	// First import: partial data (mid-day snapshot)
	workouts := []MiBandWorkout{
		{
			UserID:        userID,
			SourceStartMs: startMs,
			SourceEndMs:   startMs + 3600000,
			ActivityType:  12,
			ActivityName:  "cycling",
			DurationSec:   3600,
			DistanceM:     10000,
			Steps:         1000,
			Calories:      300,
		},
	}
	imported, _, err := db.ImportMiBand(ctx, workouts, nil)
	if err != nil {
		t.Fatalf("first import: %v", err)
	}
	if imported != 1 {
		t.Errorf("first import: expected 1, got %d", imported)
	}

	// Second import: complete data (end-of-day) with later end time
	workouts[0].SourceEndMs = startMs + 7200000 // later end time triggers conditional UPSERT
	workouts[0].Steps = 5000
	workouts[0].Calories = 800
	workouts[0].DistanceM = 25000
	workouts[0].DurationSec = 7200

	imported, _, err = db.ImportMiBand(ctx, workouts, nil)
	if err != nil {
		t.Fatalf("second import: %v", err)
	}
	if imported != 0 {
		t.Errorf("second import: expected 0 (update, not new), got %d", imported)
	}

	// Verify updated values
	result, err := db.ListMiBand(ctx, userID, 10)
	if err != nil {
		t.Fatalf("ListMiBand: %v", err)
	}
	if len(result) != 1 {
		t.Fatalf("expected 1 workout, got %d", len(result))
	}
	if result[0].Steps != 5000 {
		t.Errorf("expected steps=5000, got %d", result[0].Steps)
	}
	if result[0].Calories != 800 {
		t.Errorf("expected calories=800, got %d", result[0].Calories)
	}
	if result[0].DistanceM != 25000 {
		t.Errorf("expected distance=25000, got %f", result[0].DistanceM)
	}
}

func TestInsertMiBand_StaleDataProtection(t *testing.T) {
	// Importing an older backup after a complete one must NOT overwrite with stale values.
	db := setupMiBandTestStore(t)
	ctx := context.Background()
	userID := int64(42)
	startMs := recentMs(5)

	// First insert: complete workout (later end time, higher values)
	complete := &MiBandWorkout{
		UserID: userID, SourceStartMs: startMs, SourceEndMs: startMs + 7200000,
		ActivityType: 12, ActivityName: "running",
		DurationSec: 7200, DistanceM: 8000, Steps: 5000, Calories: 500, HeartRateAvg: 145,
	}
	inserted, err := db.InsertMiBand(ctx, complete)
	if err != nil {
		t.Fatalf("first insert: %v", err)
	}
	if !inserted {
		t.Error("expected first insert to return true")
	}

	// Second insert: stale partial data (earlier end time, lower values)
	stale := &MiBandWorkout{
		UserID: userID, SourceStartMs: startMs, SourceEndMs: startMs + 3600000,
		ActivityType: 12, ActivityName: "running",
		DurationSec: 3600, DistanceM: 3000, Steps: 1000, Calories: 200, HeartRateAvg: 130,
	}
	inserted, err = db.InsertMiBand(ctx, stale)
	if err != nil {
		t.Fatalf("second insert: %v", err)
	}
	if inserted {
		t.Error("expected second insert to return false")
	}

	// Verify complete values are preserved (not overwritten by stale data)
	result, err := db.ListMiBand(ctx, userID, 10)
	if err != nil {
		t.Fatalf("ListMiBand: %v", err)
	}
	if len(result) != 1 {
		t.Fatalf("expected 1 workout, got %d", len(result))
	}
	if result[0].Steps != 5000 {
		t.Errorf("stale data overwrote steps: expected 5000, got %d", result[0].Steps)
	}
	if result[0].DistanceM != 8000 {
		t.Errorf("stale data overwrote distance: expected 8000, got %f", result[0].DistanceM)
	}
	if result[0].SourceEndMs != startMs+7200000 {
		t.Errorf("stale data overwrote source_end_ms: expected %d, got %d", startMs+7200000, result[0].SourceEndMs)
	}
}

func TestImportMiBand_StaleDataProtection(t *testing.T) {
	// Importing an older backup after a complete one must NOT overwrite with stale values.
	db := setupMiBandTestStore(t)
	ctx := context.Background()
	userID := int64(42)
	startMs := recentMs(5)

	// First import: complete workout
	complete := []MiBandWorkout{{
		UserID: userID, SourceStartMs: startMs, SourceEndMs: startMs + 7200000,
		ActivityType: 12, ActivityName: "cycling",
		DurationSec: 7200, DistanceM: 25000, Steps: 5000, Calories: 800,
	}}
	imported, _, err := db.ImportMiBand(ctx, complete, nil)
	if err != nil {
		t.Fatalf("first import: %v", err)
	}
	if imported != 1 {
		t.Errorf("first import: expected 1, got %d", imported)
	}

	// Second import: stale partial data (earlier end time)
	stale := []MiBandWorkout{{
		UserID: userID, SourceStartMs: startMs, SourceEndMs: startMs + 3600000,
		ActivityType: 12, ActivityName: "cycling",
		DurationSec: 3600, DistanceM: 10000, Steps: 1000, Calories: 300,
	}}
	_, _, err = db.ImportMiBand(ctx, stale, nil)
	if err != nil {
		t.Fatalf("second import: %v", err)
	}

	// Verify complete values are preserved
	result, err := db.ListMiBand(ctx, userID, 10)
	if err != nil {
		t.Fatalf("ListMiBand: %v", err)
	}
	if len(result) != 1 {
		t.Fatalf("expected 1 workout, got %d", len(result))
	}
	if result[0].Steps != 5000 {
		t.Errorf("stale data overwrote steps: expected 5000, got %d", result[0].Steps)
	}
	if result[0].DistanceM != 25000 {
		t.Errorf("stale data overwrote distance: expected 25000, got %f", result[0].DistanceM)
	}
	if result[0].Calories != 800 {
		t.Errorf("stale data overwrote calories: expected 800, got %d", result[0].Calories)
	}
}

func TestInsertMiBand_ZeroMetricsDoNotOverwrite(t *testing.T) {
	// A resend with same end_time but zero metrics must NOT zero out stored values.
	db := setupMiBandTestStore(t)
	ctx := context.Background()
	userID := int64(42)
	startMs := recentMs(5)

	// First insert with full metrics
	w := &MiBandWorkout{
		UserID: userID, SourceStartMs: startMs, SourceEndMs: startMs + 3600000,
		ActivityType: 12, ActivityName: "running",
		DurationSec: 3600, DistanceM: 5000, Steps: 4000, Calories: 300, HeartRateAvg: 140,
	}
	_, err := db.InsertMiBand(ctx, w)
	if err != nil {
		t.Fatalf("first insert: %v", err)
	}

	// Second insert: same timestamps but zero metrics (simulates incomplete webhook resend)
	w2 := &MiBandWorkout{
		UserID: userID, SourceStartMs: startMs, SourceEndMs: startMs + 3600000,
		ActivityName: "running",
		// DurationSec, DistanceM, Steps, Calories all default to 0
	}
	_, err = db.InsertMiBand(ctx, w2)
	if err != nil {
		t.Fatalf("second insert: %v", err)
	}

	result, _ := db.ListMiBand(ctx, userID, 1)
	if len(result) != 1 {
		t.Fatalf("expected 1 workout, got %d", len(result))
	}
	if result[0].DurationSec != 3600 {
		t.Errorf("zero-metric resend overwrote duration: expected 3600, got %d", result[0].DurationSec)
	}
	if result[0].DistanceM != 5000 {
		t.Errorf("zero-metric resend overwrote distance: expected 5000, got %f", result[0].DistanceM)
	}
	if result[0].Steps != 4000 {
		t.Errorf("zero-metric resend overwrote steps: expected 4000, got %d", result[0].Steps)
	}
	if result[0].Calories != 300 {
		t.Errorf("zero-metric resend overwrote calories: expected 300, got %d", result[0].Calories)
	}
}

func TestImportMiBand_ZeroMetricsDoNotOverwrite(t *testing.T) {
	// Same test for the batch import path.
	db := setupMiBandTestStore(t)
	ctx := context.Background()
	userID := int64(42)
	startMs := recentMs(5)

	workouts := []MiBandWorkout{{
		UserID: userID, SourceStartMs: startMs, SourceEndMs: startMs + 3600000,
		ActivityType: 12, ActivityName: "cycling",
		DurationSec: 1800, DistanceM: 8000, Steps: 2000, Calories: 400,
	}}
	_, _, err := db.ImportMiBand(ctx, workouts, nil)
	if err != nil {
		t.Fatalf("first import: %v", err)
	}

	// Re-import with same end time but zeroed metrics
	workouts[0].DurationSec = 0
	workouts[0].DistanceM = 0
	workouts[0].Steps = 0
	workouts[0].Calories = 0
	_, _, err = db.ImportMiBand(ctx, workouts, nil)
	if err != nil {
		t.Fatalf("second import: %v", err)
	}

	result, _ := db.ListMiBand(ctx, userID, 1)
	if len(result) != 1 {
		t.Fatalf("expected 1 workout, got %d", len(result))
	}
	if result[0].DurationSec != 1800 {
		t.Errorf("zero-metric resend overwrote duration: expected 1800, got %d", result[0].DurationSec)
	}
	if result[0].DistanceM != 8000 {
		t.Errorf("zero-metric resend overwrote distance: expected 8000, got %f", result[0].DistanceM)
	}
	if result[0].Steps != 2000 {
		t.Errorf("zero-metric resend overwrote steps: expected 2000, got %d", result[0].Steps)
	}
	if result[0].Calories != 400 {
		t.Errorf("zero-metric resend overwrote calories: expected 400, got %d", result[0].Calories)
	}
}

func TestImportMiBand_WithGPS(t *testing.T) {
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

	imported, _, err := db.ImportMiBand(ctx, workouts, gpsPoints)
	if err != nil {
		t.Fatalf("ImportMiBand with GPS: %v", err)
	}
	if imported != 1 {
		t.Fatalf("expected 1 imported, got %d", imported)
	}

	// Fetch the workout to get its ID
	result, err := db.ListMiBand(ctx, userID, 1)
	if err != nil || len(result) != 1 {
		t.Fatalf("ListMiBand: %v (len=%d)", err, len(result))
	}
	workoutID := result[0].ID

	// Fetch GPS track
	pts, err := db.GetMiBandGPS(ctx, workoutID)
	if err != nil {
		t.Fatalf("GetMiBandGPS: %v", err)
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

func TestImportMiBand_GPSNotDuplicatedOnReimport(t *testing.T) {
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
	if _, _, err := db.ImportMiBand(ctx, workouts, gps); err != nil {
		t.Fatalf("first import: %v", err)
	}

	// Second import: workout is upserted (updated in place), GPS must not be re-inserted
	if _, _, err := db.ImportMiBand(ctx, workouts, gps); err != nil {
		t.Fatalf("second import: %v", err)
	}

	result, _ := db.ListMiBand(ctx, userID, 1)
	if len(result) != 1 {
		t.Fatalf("expected 1 workout, got %d", len(result))
	}
	pts, err := db.GetMiBandGPS(ctx, result[0].ID)
	if err != nil {
		t.Fatalf("GetMiBandGPS: %v", err)
	}
	if len(pts) != 1 {
		t.Errorf("expected 1 GPS point after re-import (no duplicates), got %d", len(pts))
	}
}

func TestGetMiBand_NotFound(t *testing.T) {
	db := setupMiBandTestStore(t)
	ctx := context.Background()

	result, err := db.GetMiBand(ctx, 99999)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != nil {
		t.Errorf("expected nil for non-existent workout, got %+v", result)
	}
}

func TestDeleteMiBand(t *testing.T) {
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

	if _, _, err := db.ImportMiBand(ctx, workouts, gps); err != nil {
		t.Fatalf("import: %v", err)
	}

	result, _ := db.ListMiBand(ctx, userID, 1)
	if len(result) != 1 {
		t.Fatalf("expected 1 workout, got %d", len(result))
	}
	workoutID := result[0].ID

	// Try deleting with wrong user ID
	err := db.DeleteMiBand(ctx, workoutID, otherUserID)
	if err != sql.ErrNoRows {
		t.Errorf("expected ErrNoRows when deleting with wrong user ID, got %v", err)
	}

	// Delete with correct user ID
	err = db.DeleteMiBand(ctx, workoutID, userID)
	if err != nil {
		t.Errorf("expected nil error on successful delete, got %v", err)
	}

	// Verify workout is gone
	w, err := db.GetMiBand(ctx, workoutID)
	if err != nil {
		t.Fatalf("unexpected error fetching deleted workout: %v", err)
	}
	if w != nil {
		t.Errorf("expected nil workout, got %+v", w)
	}

	// Verify GPS track is also gone (cascade)
	pts, err := db.GetMiBandGPS(ctx, workoutID)
	if err != nil {
		t.Fatalf("unexpected error fetching GPS for deleted workout: %v", err)
	}
	if len(pts) != 0 {
		t.Errorf("expected 0 GPS points after cascade delete, got %d", len(pts))
	}
}

func TestUpdateMiBand(t *testing.T) {
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

	if _, _, err := db.ImportMiBand(ctx, workouts, nil); err != nil {
		t.Fatalf("import: %v", err)
	}

	result, _ := db.ListMiBand(ctx, userID, 1)
	if len(result) != 1 {
		t.Fatalf("expected 1 workout, got %d", len(result))
	}
	workoutID := result[0].ID

	// Update single field
	newSteps := 5000
	err := db.UpdateMiBand(ctx, workoutID, userID, UpdateMiBandWorkoutFields{
		Steps: &newSteps,
	})
	if err != nil {
		t.Errorf("unexpected error updating single field: %v", err)
	}

	w, _ := db.GetMiBand(ctx, workoutID)
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

	err = db.UpdateMiBand(ctx, workoutID, userID, UpdateMiBandWorkoutFields{
		DistanceM:    &newDist,
		DurationSec:  &newDur,
		Calories:     &newCal,
		HeartRateAvg: &newHR,
		SpO2Avg:      &newSpO2,
	})
	if err != nil {
		t.Errorf("unexpected error updating multiple fields: %v", err)
	}

	w, _ = db.GetMiBand(ctx, workoutID)
	if w.DistanceM != newDist || w.DurationSec != newDur || w.Calories != newCal || w.HeartRateAvg != newHR || w.SpO2Avg != newSpO2 {
		t.Errorf("multiple field update failed. got: %+v", w)
	}
	// Verify steps wasn't overwritten by nil pointer
	if w.Steps != newSteps {
		t.Errorf("expected steps to remain %d, got %d", newSteps, w.Steps)
	}

	// Update non-existent
	err = db.UpdateMiBand(ctx, 99999, userID, UpdateMiBandWorkoutFields{Steps: &newSteps})
	if err != sql.ErrNoRows {
		t.Errorf("expected ErrNoRows updating non-existent workout, got %v", err)
	}

	// Update wrong user
	err = db.UpdateMiBand(ctx, workoutID, 99, UpdateMiBandWorkoutFields{Steps: &newSteps})
	if err != sql.ErrNoRows {
		t.Errorf("expected ErrNoRows updating with wrong user ID, got %v", err)
	}
}
