package server

import (
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

	if resp.AverageHeartRate7d != 0 {
		t.Errorf("Expected 0 avg heart rate, got %d", resp.AverageHeartRate7d)
	}
	if resp.AverageSleepHours7d != 0 {
		t.Errorf("Expected 0 avg sleep hours, got %f", resp.AverageSleepHours7d)
	}
	if resp.AverageSteps7d != 0 {
		t.Errorf("Expected 0 avg steps, got %d", resp.AverageSteps7d)
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
	_, _, err := db.ImportVitals(ctx, userID, heartLogs, nil, nil)
	if err != nil {
		t.Fatalf("ImportVitals heart: %v", err)
	}

	// Import SpO2 data
	spo2Logs := []store.VitalsSpO2Log{
		{DateTime: now.Add(-1 * time.Hour), TzOffset: 0, Value: 98, Type: 1},
		{DateTime: now.Add(-2 * time.Hour), TzOffset: 0, Value: 97, Type: 1},
	}
	_, _, err = db.ImportVitals(ctx, userID, nil, spo2Logs, nil)
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
	_, _, err = db.ImportSleepLogs(ctx, userID, sleepLogs)
	if err != nil {
		t.Fatalf("ImportSleepLogs: %v", err)
	}

	// Import day stats
	dayStats := []store.DayStat{
		{Day: now.Format("2006-01-02"), Steps: 10000, Calories: 2500, Distance: 7000},
	}
	_, _, err = db.ImportDayStats(ctx, userID, dayStats)
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
	if resp.AverageHeartRate7d != 80 {
		t.Errorf("Expected avg heart rate 80, got %d", resp.AverageHeartRate7d)
	}

	// SpO2 average: (98+97)/2 = 97 (integer division)
	if resp.AverageSpO27d != 97 {
		t.Errorf("Expected avg SpO2 97, got %d", resp.AverageSpO27d)
	}

	// Sleep hours: 480 min / 60 = 8.0
	if resp.AverageSleepHours7d != 8.0 {
		t.Errorf("Expected avg sleep hours 8.0, got %f", resp.AverageSleepHours7d)
	}

	// Steps
	if resp.AverageSteps7d != 10000 {
		t.Errorf("Expected avg steps 10000, got %d", resp.AverageSteps7d)
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
	_, _, err := db.ImportVitals(ctx, userID, heartLogs, nil, nil)
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
	if resp.AverageHeartRate7d != 75 {
		t.Errorf("Expected 7d avg 75, got %d", resp.AverageHeartRate7d)
	}

	// 30d: (70+80+60)/3 = 70
	if resp.AverageHeartRate30d != 70 {
		t.Errorf("Expected 30d avg 70, got %d", resp.AverageHeartRate30d)
	}
}
