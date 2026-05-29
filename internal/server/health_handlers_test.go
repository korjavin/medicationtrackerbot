package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func createHealthTestServer(t *testing.T) (*Server, *store.Store) {
	t.Helper()
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	srv := New(db, "test-token", "test-secret", 123456, OIDCConfig{}, "test-bot", "")
	t.Cleanup(func() { _ = srv.Shutdown(context.Background()) })
	return srv, db
}

func TestHandleGetHealthOverview_Empty(t *testing.T) {
	srv, db := createHealthTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("GET", "/api/health/overview", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleGetHealthOverview(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	var resp HealthOverviewResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("Decode error: %v", err)
	}

	if resp.AverageHeartRate7d != nil {
		t.Errorf("Expected nil avg heart rate, got %d", *resp.AverageHeartRate7d)
	}
	if resp.AverageSleepHours7d != nil {
		t.Errorf("Expected nil avg sleep hours, got %f", *resp.AverageSleepHours7d)
	}
	if resp.AverageSteps7d != nil {
		t.Errorf("Expected nil avg steps, got %d", *resp.AverageSteps7d)
	}
}

func TestHandleGetHealthOverview_WithData(t *testing.T) {
	srv, db := createHealthTestServer(t)
	defer db.Close()

	ctx := ctxWithUser(123456)
	userID := int64(123456)
	now := time.Now().UTC()

	// Import heart rate data (within last 7 days)
	heartLogs := []store.VitalsHeartLog{
		{DateTime: now.Add(-1 * time.Hour), TzOffset: 0, Value: 70, Type: 1},
		{DateTime: now.Add(-2 * time.Hour), TzOffset: 0, Value: 80, Type: 1},
		{DateTime: now.Add(-3 * time.Hour), TzOffset: 0, Value: 90, Type: 1},
	}
	_, _, err := db.Vitals.ImportVitals(ctx, userID, heartLogs, nil, nil)
	if err != nil {
		t.Fatalf("ImportVitals heart: %v", err)
	}

	// Import SpO2 data
	spo2Logs := []store.VitalsSpO2Log{
		{DateTime: now.Add(-1 * time.Hour), TzOffset: 0, Value: 98, Type: 1},
		{DateTime: now.Add(-2 * time.Hour), TzOffset: 0, Value: 97, Type: 1},
	}
	_, _, err = db.Vitals.ImportVitals(ctx, userID, nil, spo2Logs, nil)
	if err != nil {
		t.Fatalf("ImportVitals spo2: %v", err)
	}

	// Import sleep data
	totalMins := 480
	sleepLogs := []store.SleepLog{
		{
			StartTime:      now.Add(-10 * time.Hour),
			EndTime:        now.Add(-2 * time.Hour),
			TimezoneOffset: 0,
			Day:            now.Add(-10 * time.Hour).Format("2006-01-02"),
			TotalMinutes:   &totalMins,
		},
	}
	_, _, err = db.Vitals.ImportSleepLogs(ctx, userID, sleepLogs)
	if err != nil {
		t.Fatalf("ImportSleepLogs: %v", err)
	}

	// Import day stats
	dayStats := []store.DayStat{
		{Day: now.Format("2006-01-02"), Steps: 10000, Calories: 2500, Distance: 7000},
	}
	_, _, err = db.Vitals.ImportDayStats(ctx, userID, dayStats)
	if err != nil {
		t.Fatalf("ImportDayStats: %v", err)
	}

	req := httptest.NewRequest("GET", "/api/health/overview", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleGetHealthOverview(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	var resp HealthOverviewResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("Decode error: %v", err)
	}

	// Heart rate average: (70+80+90)/3 = 80
	if resp.AverageHeartRate7d == nil || *resp.AverageHeartRate7d != 80 {
		t.Errorf("Expected avg heart rate 80, got %v", resp.AverageHeartRate7d)
	}

	// SpO2 average: (98+97)/2 = 97 (integer division)
	if resp.AverageSpO27d == nil || *resp.AverageSpO27d != 97 {
		t.Errorf("Expected avg SpO2 97, got %v", resp.AverageSpO27d)
	}

	// Sleep hours: 480 min / 60 = 8.0
	if resp.AverageSleepHours7d == nil || *resp.AverageSleepHours7d != 8.0 {
		t.Errorf("Expected avg sleep hours 8.0, got %v", resp.AverageSleepHours7d)
	}

	// Steps
	if resp.AverageSteps7d == nil || *resp.AverageSteps7d != 10000 {
		t.Errorf("Expected avg steps 10000, got %v", resp.AverageSteps7d)
	}

	// Heart rate history should have bucketed entries
	if len(resp.HeartRateHistory7d) == 0 {
		t.Error("Expected heart rate history entries")
	}
}

func TestHandleGetHealthOverview_30dVs7dAverages(t *testing.T) {
	srv, db := createHealthTestServer(t)
	defer db.Close()

	ctx := ctxWithUser(123456)
	userID := int64(123456)
	now := time.Now().UTC()

	// Heart rate: 2 within 7d, 1 at 15 days ago (only in 30d)
	heartLogs := []store.VitalsHeartLog{
		{DateTime: now.Add(-1 * time.Hour), TzOffset: 0, Value: 70, Type: 1},
		{DateTime: now.Add(-2 * time.Hour), TzOffset: 0, Value: 80, Type: 1},
		{DateTime: now.Add(-15 * 24 * time.Hour), TzOffset: 0, Value: 60, Type: 1},
	}
	_, _, err := db.Vitals.ImportVitals(ctx, userID, heartLogs, nil, nil)
	if err != nil {
		t.Fatalf("ImportVitals: %v", err)
	}

	req := httptest.NewRequest("GET", "/api/health/overview", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleGetHealthOverview(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	var resp HealthOverviewResponse
	json.NewDecoder(w.Body).Decode(&resp)

	// 7d: (70+80)/2 = 75
	if resp.AverageHeartRate7d == nil || *resp.AverageHeartRate7d != 75 {
		t.Errorf("Expected 7d avg 75, got %v", resp.AverageHeartRate7d)
	}

	// 30d: (70+80+60)/3 = 70
	if resp.AverageHeartRate30d == nil || *resp.AverageHeartRate30d != 70 {
		t.Errorf("Expected 30d avg 70, got %v", resp.AverageHeartRate30d)
	}
}

func TestHandleListSleepLogs_RangeAndDefault(t *testing.T) {
	srv, db := createHealthTestServer(t)
	defer db.Close()

	ctx := ctxWithUser(123456)
	userID := int64(123456)
	now := time.Now().UTC()

	mk := func(daysAgo int, total int) store.SleepLog {
		start := now.AddDate(0, 0, -daysAgo)
		return store.SleepLog{
			StartTime:      start,
			EndTime:        start.Add(8 * time.Hour),
			TimezoneOffset: 0,
			Day:            start.Format("2006-01-02"),
			TotalMinutes:   &total,
		}
	}
	// One recent night, one ~45 days back (beyond the overview's 30d window).
	if _, _, err := db.Vitals.ImportSleepLogs(ctx, userID, []store.SleepLog{mk(2, 470), mk(45, 400)}); err != nil {
		t.Fatalf("ImportSleepLogs: %v", err)
	}

	get := func(qs string) []store.SleepLog {
		t.Helper()
		req := httptest.NewRequest("GET", "/api/health/sleep"+qs, nil)
		req = withUser(req, userID)
		w := httptest.NewRecorder()
		srv.handleListSleepLogs(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
		}
		var out []store.SleepLog
		if err := json.NewDecoder(w.Body).Decode(&out); err != nil {
			t.Fatalf("Decode error: %v", err)
		}
		return out
	}

	// Default (90d) reaches the 45-day-old night that overview would miss.
	if got := get(""); len(got) != 2 {
		t.Errorf("default window: expected 2 sleep logs, got %d", len(got))
	}

	// days=7 should exclude the 45-day-old night.
	if got := get("?days=7"); len(got) != 1 {
		t.Errorf("days=7: expected 1 sleep log, got %d", len(got))
	}

	// Explicit from/to bracketing only the old night.
	from := now.AddDate(0, 0, -50).Format("2006-01-02")
	to := now.AddDate(0, 0, -40).Format("2006-01-02")
	if got := get("?from=" + from + "&to=" + to); len(got) != 1 {
		t.Errorf("from/to range: expected 1 sleep log, got %d", len(got))
	}

	// limit caps the result set.
	if got := get("?limit=1"); len(got) != 1 {
		t.Errorf("limit=1: expected 1 sleep log, got %d", len(got))
	}
}
