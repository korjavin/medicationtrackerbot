package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func TestExternalWorkoutIntegration_FuzzyDedup(t *testing.T) {
	// Initialize real in-memory store
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("create test store: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	userID := int64(42)
	ctx := context.Background()

	// 1. Import a workout with exact ms precision (simulating a backup import)
	// Use a recent timestamp to bypass the 90-day cutoff filter in ListMiBandWorkouts
	importTime := time.Now().Unix()
	backupStartMs := importTime*1000 + 123

	workouts := []store.MiBandWorkout{
		{
			UserID:        userID,
			SourceStartMs: backupStartMs,
			SourceEndMs:   backupStartMs + 3600000,
			ActivityType:  12,
			ActivityName:  "running",
			DurationSec:   3600,
			DistanceM:     5000,
		},
	}
	imported, _, err := db.ImportMiBandWorkouts(ctx, workouts, nil)
	if err != nil {
		t.Fatalf("ImportMiBandWorkouts: %v", err)
	}
	if imported != 1 {
		t.Fatalf("expected 1 imported, got %d", imported)
	}

	// 2. Post the same workout via the external webhook (seconds precision)
	s := &Server{
		externalAPIKey: "testkey",
		miband:         db, // Use the real DB
		allowedUserID:  userID,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/workout/external", s.externalAPIKeyMiddleware(s.handleExternalWorkout))

	body := map[string]interface{}{
		"workout_type": "running",
		"start_time":   importTime, // seconds
		"distance":     5000,
	}
	reqBody, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/api/workout/external", bytes.NewReader(reqBody))
	req.Header.Set("Authorization", "Bearer testkey")

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)

	// We expect status OK and the response body should indicate it was a duplicate
	if rr.Code != http.StatusOK {
		t.Errorf("expected status %v, got %v", http.StatusOK, rr.Code)
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}
	if resp["status"] != "exists" {
		t.Errorf("expected status=exists, got %v", resp["status"])
	}

	// 3. Verify no second row was created
	result, err := db.ListMiBandWorkouts(ctx, userID, 10)
	if err != nil {
		t.Fatalf("ListMiBandWorkouts: %v", err)
	}
	if len(result) != 1 {
		t.Fatalf("expected exactly 1 workout, got %d", len(result))
	}
	if result[0].SourceStartMs != backupStartMs {
		t.Errorf("expected original ms timestamp to be preserved: %v vs %v", backupStartMs, result[0].SourceStartMs)
	}
}
