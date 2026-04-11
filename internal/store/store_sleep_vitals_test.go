package store

import (
	"context"
	"strings"
	"testing"
	"time"
)

func setupSleepVitalsTestStore(t *testing.T) *Store {
	t.Helper()
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestImportSleepLogs(t *testing.T) {
	db := setupSleepVitalsTestStore(t)
	ctx := context.Background()
	userID := int64(123456)

	light := 120
	deep := 60
	rem := 45
	awake := 15
	total := 240
	hr := 62
	spo2 := 97

	logs := []SleepLog{
		{
			StartTime:      time.Date(2025, 1, 10, 23, 0, 0, 0, time.UTC),
			EndTime:        time.Date(2025, 1, 11, 7, 0, 0, 0, time.UTC),
			TimezoneOffset: 3600,
			Day:            "2025-01-10",
			LightMinutes:   &light,
			DeepMinutes:    &deep,
			REMMinutes:     &rem,
			AwakeMinutes:   &awake,
			TotalMinutes:   &total,
			HeartRateAvg:   &hr,
			SpO2Avg:        &spo2,
		},
		{
			StartTime:      time.Date(2025, 1, 11, 23, 30, 0, 0, time.UTC),
			EndTime:        time.Date(2025, 1, 12, 6, 30, 0, 0, time.UTC),
			TimezoneOffset: 3600,
			Day:            "2025-01-11",
		},
	}

	imported, skipped, err := db.ImportSleepLogs(ctx, userID, logs)
	if err != nil {
		t.Fatalf("ImportSleepLogs: %v", err)
	}
	if imported != 2 {
		t.Errorf("Expected 2 imported, got %d", imported)
	}
	if skipped != 0 {
		t.Errorf("Expected 0 skipped, got %d", skipped)
	}

	// Verify retrieval
	result, err := db.GetSleepLogs(ctx, userID, time.Time{})
	if err != nil {
		t.Fatalf("GetSleepLogs: %v", err)
	}
	if len(result) != 2 {
		t.Fatalf("Expected 2 sleep logs, got %d", len(result))
	}

	// Ordered by start_time DESC
	// Day may be stored as "2025-01-11" or parsed as "2025-01-11T00:00:00Z" by the driver
	if !strings.Contains(result[0].Day, "2025-01-11") {
		t.Errorf("Expected first log day to contain '2025-01-11', got %q", result[0].Day)
	}
	if !strings.Contains(result[1].Day, "2025-01-10") {
		t.Errorf("Expected second log day to contain '2025-01-10', got %q", result[1].Day)
	}

	// Check optional fields on first entry (second in result due to DESC)
	sl := result[1]
	if sl.LightMinutes == nil || *sl.LightMinutes != 120 {
		t.Errorf("Expected light_minutes=120, got %v", sl.LightMinutes)
	}
	if sl.DeepMinutes == nil || *sl.DeepMinutes != 60 {
		t.Errorf("Expected deep_minutes=60, got %v", sl.DeepMinutes)
	}
	if sl.HeartRateAvg == nil || *sl.HeartRateAvg != 62 {
		t.Errorf("Expected heart_rate_avg=62, got %v", sl.HeartRateAvg)
	}

	// Check nil optional fields on second entry
	sl2 := result[0]
	if sl2.LightMinutes != nil {
		t.Errorf("Expected nil light_minutes, got %v", sl2.LightMinutes)
	}
}

func TestImportSleepLogsDuplicates(t *testing.T) {
	db := setupSleepVitalsTestStore(t)
	ctx := context.Background()
	userID := int64(123456)

	logs := []SleepLog{
		{
			StartTime:      time.Date(2025, 1, 10, 23, 0, 0, 0, time.UTC),
			EndTime:        time.Date(2025, 1, 11, 7, 0, 0, 0, time.UTC),
			TimezoneOffset: 3600,
			Day:            "2025-01-10",
		},
	}

	// Import once
	imported, _, err := db.ImportSleepLogs(ctx, userID, logs)
	if err != nil {
		t.Fatalf("First import: %v", err)
	}
	if imported != 1 {
		t.Errorf("Expected 1 imported, got %d", imported)
	}

	// Import same again (INSERT OR IGNORE)
	imported, skipped, err := db.ImportSleepLogs(ctx, userID, logs)
	if err != nil {
		t.Fatalf("Second import: %v", err)
	}
	if imported != 0 {
		t.Errorf("Expected 0 imported on duplicate, got %d", imported)
	}
	if skipped != 1 {
		t.Errorf("Expected 1 skipped on duplicate, got %d", skipped)
	}

	// Still only 1 log
	result, _ := db.GetSleepLogs(ctx, userID, time.Time{})
	if len(result) != 1 {
		t.Errorf("Expected 1 log after duplicate import, got %d", len(result))
	}
}

func TestGetSleepLogsSinceFilter(t *testing.T) {
	db := setupSleepVitalsTestStore(t)
	ctx := context.Background()
	userID := int64(123456)

	logs := []SleepLog{
		{
			StartTime:      time.Date(2025, 1, 5, 23, 0, 0, 0, time.UTC),
			EndTime:        time.Date(2025, 1, 6, 7, 0, 0, 0, time.UTC),
			TimezoneOffset: 0,
			Day:            "2025-01-05",
		},
		{
			StartTime:      time.Date(2025, 1, 10, 23, 0, 0, 0, time.UTC),
			EndTime:        time.Date(2025, 1, 11, 7, 0, 0, 0, time.UTC),
			TimezoneOffset: 0,
			Day:            "2025-01-10",
		},
	}

	_, _, err := db.ImportSleepLogs(ctx, userID, logs)
	if err != nil {
		t.Fatalf("ImportSleepLogs: %v", err)
	}

	// Filter: only logs since Jan 8
	since := time.Date(2025, 1, 8, 0, 0, 0, 0, time.UTC)
	result, err := db.GetSleepLogs(ctx, userID, since)
	if err != nil {
		t.Fatalf("GetSleepLogs with since: %v", err)
	}
	if len(result) != 1 {
		t.Fatalf("Expected 1 log since Jan 8, got %d", len(result))
	}
	if !strings.Contains(result[0].Day, "2025-01-10") {
		t.Errorf("Expected day to contain '2025-01-10', got %q", result[0].Day)
	}
}

func TestImportVitalsHeart(t *testing.T) {
	db := setupSleepVitalsTestStore(t)
	ctx := context.Background()
	userID := int64(123456)

	heartLogs := []VitalsHeartLog{
		{DateTime: time.Date(2025, 1, 10, 10, 0, 0, 0, time.UTC), TzOffset: 3600, Value: 72, Type: 1},
		{DateTime: time.Date(2025, 1, 10, 11, 0, 0, 0, time.UTC), TzOffset: 3600, Value: 85, Type: 1},
		{DateTime: time.Date(2025, 1, 10, 12, 0, 0, 0, time.UTC), TzOffset: 3600, Value: 68, Type: 2},
	}

	imported, skipped, err := db.ImportVitals(ctx, userID, heartLogs, nil, nil)
	if err != nil {
		t.Fatalf("ImportVitals heart: %v", err)
	}
	if imported != 3 {
		t.Errorf("Expected 3 imported, got %d", imported)
	}
	if skipped != 0 {
		t.Errorf("Expected 0 skipped, got %d", skipped)
	}

	// Retrieve
	start := time.Date(2025, 1, 10, 0, 0, 0, 0, time.UTC)
	end := time.Date(2025, 1, 10, 23, 59, 59, 0, time.UTC)
	result, err := db.GetVitalsHeart(ctx, userID, start, end)
	if err != nil {
		t.Fatalf("GetVitalsHeart: %v", err)
	}
	if len(result) != 3 {
		t.Fatalf("Expected 3 heart logs, got %d", len(result))
	}
	// Ordered ASC
	if result[0].Value != 72 {
		t.Errorf("Expected first value 72, got %d", result[0].Value)
	}
	if result[2].Value != 68 {
		t.Errorf("Expected last value 68, got %d", result[2].Value)
	}
}

func TestImportVitalsSpO2(t *testing.T) {
	db := setupSleepVitalsTestStore(t)
	ctx := context.Background()
	userID := int64(123456)

	spo2Logs := []VitalsSpO2Log{
		{DateTime: time.Date(2025, 1, 10, 10, 0, 0, 0, time.UTC), TzOffset: 0, Value: 98, Type: 1},
		{DateTime: time.Date(2025, 1, 10, 14, 0, 0, 0, time.UTC), TzOffset: 0, Value: 97, Type: 1},
	}

	imported, _, err := db.ImportVitals(ctx, userID, nil, spo2Logs, nil)
	if err != nil {
		t.Fatalf("ImportVitals spo2: %v", err)
	}
	if imported != 2 {
		t.Errorf("Expected 2 imported, got %d", imported)
	}

	start := time.Date(2025, 1, 10, 0, 0, 0, 0, time.UTC)
	end := time.Date(2025, 1, 10, 23, 59, 59, 0, time.UTC)
	result, err := db.GetVitalsSpO2(ctx, userID, start, end)
	if err != nil {
		t.Fatalf("GetVitalsSpO2: %v", err)
	}
	if len(result) != 2 {
		t.Fatalf("Expected 2 spo2 logs, got %d", len(result))
	}
	if result[0].Value != 98 {
		t.Errorf("Expected first value 98, got %d", result[0].Value)
	}
}

func TestImportVitalsStress(t *testing.T) {
	db := setupSleepVitalsTestStore(t)
	ctx := context.Background()
	userID := int64(123456)

	stressLogs := []VitalsStressLog{
		{DateTime: time.Date(2025, 1, 10, 9, 0, 0, 0, time.UTC), TzOffset: 0, Value: 25, Type: 1, Info: "low"},
		{DateTime: time.Date(2025, 1, 10, 15, 0, 0, 0, time.UTC), TzOffset: 0, Value: 65, Type: 1},
	}

	imported, _, err := db.ImportVitals(ctx, userID, nil, nil, stressLogs)
	if err != nil {
		t.Fatalf("ImportVitals stress: %v", err)
	}
	if imported != 2 {
		t.Errorf("Expected 2 imported, got %d", imported)
	}

	start := time.Date(2025, 1, 10, 0, 0, 0, 0, time.UTC)
	end := time.Date(2025, 1, 10, 23, 59, 59, 0, time.UTC)
	result, err := db.GetVitalsStress(ctx, userID, start, end)
	if err != nil {
		t.Fatalf("GetVitalsStress: %v", err)
	}
	if len(result) != 2 {
		t.Fatalf("Expected 2 stress logs, got %d", len(result))
	}
	if result[0].Info != "low" {
		t.Errorf("Expected info 'low', got %q", result[0].Info)
	}
	if result[1].Info != "" {
		t.Errorf("Expected empty info, got %q", result[1].Info)
	}
}

func TestImportVitalsDuplicates(t *testing.T) {
	db := setupSleepVitalsTestStore(t)
	ctx := context.Background()
	userID := int64(123456)

	heartLogs := []VitalsHeartLog{
		{DateTime: time.Date(2025, 1, 10, 10, 0, 0, 0, time.UTC), TzOffset: 0, Value: 72, Type: 1},
	}

	// Import once
	imported, _, err := db.ImportVitals(ctx, userID, heartLogs, nil, nil)
	if err != nil {
		t.Fatalf("First import: %v", err)
	}
	if imported != 1 {
		t.Errorf("Expected 1 imported, got %d", imported)
	}

	// Import again - should skip
	imported, skipped, err := db.ImportVitals(ctx, userID, heartLogs, nil, nil)
	if err != nil {
		t.Fatalf("Second import: %v", err)
	}
	if imported != 0 {
		t.Errorf("Expected 0 imported on duplicate, got %d", imported)
	}
	if skipped != 1 {
		t.Errorf("Expected 1 skipped on duplicate, got %d", skipped)
	}
}

func TestImportVitalsMixed(t *testing.T) {
	db := setupSleepVitalsTestStore(t)
	ctx := context.Background()
	userID := int64(123456)

	heartLogs := []VitalsHeartLog{
		{DateTime: time.Date(2025, 1, 10, 10, 0, 0, 0, time.UTC), TzOffset: 0, Value: 72, Type: 1},
	}
	spo2Logs := []VitalsSpO2Log{
		{DateTime: time.Date(2025, 1, 10, 10, 0, 0, 0, time.UTC), TzOffset: 0, Value: 98, Type: 1},
	}
	stressLogs := []VitalsStressLog{
		{DateTime: time.Date(2025, 1, 10, 10, 0, 0, 0, time.UTC), TzOffset: 0, Value: 30, Type: 1},
	}

	imported, skipped, err := db.ImportVitals(ctx, userID, heartLogs, spo2Logs, stressLogs)
	if err != nil {
		t.Fatalf("ImportVitals mixed: %v", err)
	}
	if imported != 3 {
		t.Errorf("Expected 3 imported, got %d", imported)
	}
	if skipped != 0 {
		t.Errorf("Expected 0 skipped, got %d", skipped)
	}
}

func TestGetVitalsHeartTimeRange(t *testing.T) {
	db := setupSleepVitalsTestStore(t)
	ctx := context.Background()
	userID := int64(123456)

	heartLogs := []VitalsHeartLog{
		{DateTime: time.Date(2025, 1, 10, 8, 0, 0, 0, time.UTC), TzOffset: 0, Value: 60, Type: 1},
		{DateTime: time.Date(2025, 1, 10, 12, 0, 0, 0, time.UTC), TzOffset: 0, Value: 75, Type: 1},
		{DateTime: time.Date(2025, 1, 10, 18, 0, 0, 0, time.UTC), TzOffset: 0, Value: 70, Type: 1},
	}

	_, _, err := db.ImportVitals(ctx, userID, heartLogs, nil, nil)
	if err != nil {
		t.Fatalf("ImportVitals: %v", err)
	}

	// Query only 10:00-14:00
	start := time.Date(2025, 1, 10, 10, 0, 0, 0, time.UTC)
	end := time.Date(2025, 1, 10, 14, 0, 0, 0, time.UTC)
	result, err := db.GetVitalsHeart(ctx, userID, start, end)
	if err != nil {
		t.Fatalf("GetVitalsHeart: %v", err)
	}
	if len(result) != 1 {
		t.Fatalf("Expected 1 heart log in range, got %d", len(result))
	}
	if result[0].Value != 75 {
		t.Errorf("Expected value 75, got %d", result[0].Value)
	}
}

func TestImportDayStats(t *testing.T) {
	db := setupSleepVitalsTestStore(t)
	ctx := context.Background()
	userID := int64(123456)

	stats := []DayStat{
		{Day: "2025-01-10", Steps: 8000, Calories: 2200, Distance: 5500},
		{Day: "2025-01-11", Steps: 12000, Calories: 2500, Distance: 8000},
	}

	imported, skipped, err := db.ImportDayStats(ctx, userID, stats)
	if err != nil {
		t.Fatalf("ImportDayStats: %v", err)
	}
	if imported != 2 {
		t.Errorf("Expected 2 imported, got %d", imported)
	}
	if skipped != 0 {
		t.Errorf("Expected 0 skipped, got %d", skipped)
	}

	// Retrieve
	result, err := db.GetDayStats(ctx, userID, time.Time{})
	if err != nil {
		t.Fatalf("GetDayStats: %v", err)
	}
	if len(result) != 2 {
		t.Fatalf("Expected 2 day stats, got %d", len(result))
	}
	// Ordered DESC by day
	if result[0].Day != "2025-01-11" {
		t.Errorf("Expected first day '2025-01-11', got %q", result[0].Day)
	}
	if result[0].Steps != 12000 {
		t.Errorf("Expected 12000 steps, got %d", result[0].Steps)
	}
}

func TestImportDayStatsDuplicates(t *testing.T) {
	db := setupSleepVitalsTestStore(t)
	ctx := context.Background()
	userID := int64(123456)

	stats := []DayStat{
		{Day: "2025-01-10", Steps: 8000, Calories: 2200, Distance: 5500},
	}

	// Import once
	imported, _, err := db.ImportDayStats(ctx, userID, stats)
	if err != nil {
		t.Fatalf("First import: %v", err)
	}
	if imported != 1 {
		t.Errorf("Expected 1 imported, got %d", imported)
	}

	// Import again — UPSERT counts re-imports as imported (rowsAffected=1)
	imported, skipped, err := db.ImportDayStats(ctx, userID, stats)
	if err != nil {
		t.Fatalf("Second import: %v", err)
	}
	if imported != 1 {
		t.Errorf("Expected 1 imported (upsert), got %d", imported)
	}
	if skipped != 0 {
		t.Errorf("Expected 0 skipped, got %d", skipped)
	}

	// Still only 1 row
	result, err := db.GetDayStats(ctx, userID, time.Time{})
	if err != nil {
		t.Fatalf("GetDayStats: %v", err)
	}
	if len(result) != 1 {
		t.Errorf("Expected 1 stat after duplicate import, got %d", len(result))
	}
}

func TestImportDayStatsUpsertUpdatesValues(t *testing.T) {
	db := setupSleepVitalsTestStore(t)
	ctx := context.Background()
	userID := int64(123456)

	// Import partial data (mid-day snapshot)
	partial := []DayStat{
		{Day: "2025-01-10", Steps: 2000, Calories: 800, Distance: 1500},
	}
	_, _, err := db.ImportDayStats(ctx, userID, partial)
	if err != nil {
		t.Fatalf("First import: %v", err)
	}

	// Import complete data (end-of-day snapshot)
	complete := []DayStat{
		{Day: "2025-01-10", Steps: 8000, Calories: 2200, Distance: 5500},
	}
	imported, skipped, err := db.ImportDayStats(ctx, userID, complete)
	if err != nil {
		t.Fatalf("Second import: %v", err)
	}
	if imported != 1 {
		t.Errorf("Expected 1 imported (upsert), got %d", imported)
	}
	if skipped != 0 {
		t.Errorf("Expected 0 skipped, got %d", skipped)
	}

	// Verify values updated
	result, err := db.GetDayStats(ctx, userID, time.Time{})
	if err != nil {
		t.Fatalf("GetDayStats: %v", err)
	}
	if len(result) != 1 {
		t.Fatalf("Expected 1 row, got %d", len(result))
	}
	if result[0].Steps != 8000 {
		t.Errorf("Expected steps=8000, got %d", result[0].Steps)
	}
	if result[0].Calories != 2200 {
		t.Errorf("Expected calories=2200, got %d", result[0].Calories)
	}
	if result[0].Distance != 5500 {
		t.Errorf("Expected distance=5500, got %d", result[0].Distance)
	}
}

func TestImportDayStatsUpsertDifferentDays(t *testing.T) {
	db := setupSleepVitalsTestStore(t)
	ctx := context.Background()
	userID := int64(123456)

	// Import day 1
	day1 := []DayStat{
		{Day: "2025-01-10", Steps: 5000, Calories: 1800, Distance: 3000},
	}
	_, _, err := db.ImportDayStats(ctx, userID, day1)
	if err != nil {
		t.Fatalf("First import: %v", err)
	}

	// Import day 2 (different day)
	day2 := []DayStat{
		{Day: "2025-01-11", Steps: 10000, Calories: 2500, Distance: 7000},
	}
	_, _, err = db.ImportDayStats(ctx, userID, day2)
	if err != nil {
		t.Fatalf("Second import: %v", err)
	}

	// Both days exist
	result, err := db.GetDayStats(ctx, userID, time.Time{})
	if err != nil {
		t.Fatalf("GetDayStats: %v", err)
	}
	if len(result) != 2 {
		t.Fatalf("Expected 2 rows, got %d", len(result))
	}
}

func TestGetDayStatsSinceFilter(t *testing.T) {
	db := setupSleepVitalsTestStore(t)
	ctx := context.Background()
	userID := int64(123456)

	stats := []DayStat{
		{Day: "2025-01-05", Steps: 5000, Calories: 1800, Distance: 3000},
		{Day: "2025-01-10", Steps: 10000, Calories: 2400, Distance: 7000},
	}

	_, _, err := db.ImportDayStats(ctx, userID, stats)
	if err != nil {
		t.Fatalf("ImportDayStats: %v", err)
	}

	since := time.Date(2025, 1, 8, 0, 0, 0, 0, time.UTC)
	result, err := db.GetDayStats(ctx, userID, since)
	if err != nil {
		t.Fatalf("GetDayStats with since: %v", err)
	}
	if len(result) != 1 {
		t.Fatalf("Expected 1 stat since Jan 8, got %d", len(result))
	}
	if result[0].Day != "2025-01-10" {
		t.Errorf("Expected day '2025-01-10', got %q", result[0].Day)
	}
}
