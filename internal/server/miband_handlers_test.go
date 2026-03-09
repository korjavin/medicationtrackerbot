package server

import (
	"bytes"
	"strconv"

	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func TestHandleListMiBandWorkouts_Empty(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("GET", "/api/health/miband/workouts", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleListMiBandWorkouts(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var result []any
	if err := json.NewDecoder(w.Body).Decode(&result); err != nil {
		t.Fatalf("Decode error: %v", err)
	}
	if len(result) != 0 {
		t.Errorf("Expected empty array, got %d items", len(result))
	}
}

func TestHandleListMiBandWorkouts_WithData(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	ctx := context.Background()
	userID := int64(123456)
	now := time.Now()

	workouts := []store.MiBandWorkout{
		{
			UserID:        userID,
			SourceStartMs: now.Add(-2 * time.Hour).UnixMilli(),
			SourceEndMs:   now.Add(-1 * time.Hour).UnixMilli(),
			ActivityType:  1,
			ActivityName:  "running",
			DurationSec:   3600,
			DistanceM:     8000,
			Steps:         9000,
			Calories:      500,
			HeartRateAvg:  155,
			SpO2Avg:       98,
			TzOffset:      0,
		},
	}

	imported, _, err := db.ImportMiBandWorkouts(ctx, workouts, nil)
	if err != nil {
		t.Fatalf("ImportMiBandWorkouts: %v", err)
	}
	if imported != 1 {
		t.Fatalf("Expected 1 imported, got %d", imported)
	}

	req := httptest.NewRequest("GET", "/api/health/miband/workouts", nil)
	req = withUser(req, userID)
	w := httptest.NewRecorder()

	srv.handleListMiBandWorkouts(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var result []map[string]any
	if err := json.NewDecoder(w.Body).Decode(&result); err != nil {
		t.Fatalf("Decode error: %v", err)
	}

	if len(result) != 1 {
		t.Fatalf("Expected 1 workout, got %d", len(result))
	}

	wo := result[0]
	if wo["activity_name"] != "running" {
		t.Errorf("Expected activity_name='running', got %v", wo["activity_name"])
	}
	if wo["duration_sec"] != float64(3600) {
		t.Errorf("Expected duration_sec=3600, got %v", wo["duration_sec"])
	}
	if wo["heart_rate_avg"] != float64(155) {
		t.Errorf("Expected heart_rate_avg=155, got %v", wo["heart_rate_avg"])
	}
	// start_time and end_time should be non-empty RFC3339 strings
	if wo["start_time"] == "" || wo["start_time"] == nil {
		t.Error("Expected non-empty start_time")
	}
	if wo["end_time"] == "" || wo["end_time"] == nil {
		t.Error("Expected non-empty end_time")
	}
}

func TestHandleListMiBandWorkouts_LimitParam(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	ctx := context.Background()
	userID := int64(123456)
	now := time.Now()

	// Insert 3 workouts
	workouts := []store.MiBandWorkout{
		{UserID: userID, SourceStartMs: now.Add(-6 * time.Hour).UnixMilli(), SourceEndMs: now.Add(-5 * time.Hour).UnixMilli(), ActivityName: "run1"},
		{UserID: userID, SourceStartMs: now.Add(-4 * time.Hour).UnixMilli(), SourceEndMs: now.Add(-3 * time.Hour).UnixMilli(), ActivityName: "run2"},
		{UserID: userID, SourceStartMs: now.Add(-2 * time.Hour).UnixMilli(), SourceEndMs: now.Add(-1 * time.Hour).UnixMilli(), ActivityName: "run3"},
	}
	db.ImportMiBandWorkouts(ctx, workouts, nil)

	req := httptest.NewRequest("GET", "/api/health/miband/workouts?limit=2", nil)
	req = withUser(req, userID)
	w := httptest.NewRecorder()

	srv.handleListMiBandWorkouts(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	var result []map[string]any
	json.NewDecoder(w.Body).Decode(&result)

	if len(result) != 2 {
		t.Errorf("Expected 2 results with limit=2, got %d", len(result))
	}
}

func TestHandleGetMiBandWorkoutGPS_InvalidID(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("GET", "/api/health/miband/workouts/notanid/gps", nil)
	req.SetPathValue("id", "notanid")
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleGetMiBandWorkoutGPS(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("Expected 400 for invalid ID, got %d", w.Code)
	}
}

func TestHandleGetMiBandWorkoutGPS_NotFound(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("GET", "/api/health/miband/workouts/99999/gps", nil)
	req.SetPathValue("id", "99999")
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleGetMiBandWorkoutGPS(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("Expected 404 for non-existent workout, got %d", w.Code)
	}
}

func TestHandleGetMiBandWorkoutGPS_EmptyGPS(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	ctx := context.Background()
	userID := int64(123456)
	now := time.Now()

	// Import a workout without GPS
	workouts := []store.MiBandWorkout{
		{
			UserID:        userID,
			SourceStartMs: now.Add(-2 * time.Hour).UnixMilli(),
			SourceEndMs:   now.Add(-1 * time.Hour).UnixMilli(),
			ActivityName:  "cycling",
		},
	}
	db.ImportMiBandWorkouts(ctx, workouts, nil)

	// Get the workout ID
	imported, _ := db.ListMiBandWorkouts(ctx, userID, 10)
	if len(imported) == 0 {
		t.Fatal("Expected at least 1 imported workout")
	}
	workoutID := imported[0].ID

	req := httptest.NewRequest("GET", "/api/health/miband/workouts/0/gps", nil)
	req.SetPathValue("id", fmt.Sprintf("%d", workoutID))
	req = withUser(req, userID)
	w := httptest.NewRecorder()

	srv.handleGetMiBandWorkoutGPS(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var pts []any
	json.NewDecoder(w.Body).Decode(&pts)
	if len(pts) != 0 {
		t.Errorf("Expected empty GPS track, got %d points", len(pts))
	}
}

func TestDeleteMiBandWorkoutHandler(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()
	userID := srv.allowedUserID

	// Setup a workout
	startMs := time.Now().UnixMilli()
	workouts := []store.MiBandWorkout{
		{
			UserID: userID, SourceStartMs: startMs, SourceEndMs: startMs + 1000,
			ActivityType: 1, ActivityName: "test", DurationSec: 1, DistanceM: 10,
		},
	}
	_, _, err := db.ImportMiBandWorkouts(context.Background(), workouts, nil)
	if err != nil {
		t.Fatalf("import: %v", err)
	}

	result, _ := db.ListMiBandWorkouts(context.Background(), userID, 1)
	if len(result) != 1 {
		t.Fatalf("expected 1 workout")
	}
	workoutID := result[0].ID

	// Test deleting non-existent workout (404)
	req := httptest.NewRequest("DELETE", "/api/workout/miband/99999", nil)
	req.SetPathValue("id", "99999")
	w := httptest.NewRecorder()
	srv.handleDeleteMiBandWorkout(w, withUser(req, userID))
	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404 for non-existent workout, got %d", w.Code)
	}

	// Test deleting real workout (204)
	req = httptest.NewRequest("DELETE", "/api/workout/miband/"+strconv.FormatInt(workoutID, 10), nil)
	req.SetPathValue("id", strconv.FormatInt(workoutID, 10))
	w = httptest.NewRecorder()
	srv.handleDeleteMiBandWorkout(w, withUser(req, userID))
	if w.Code != http.StatusNoContent {
		t.Errorf("expected 204 for successful delete, got %d", w.Code)
	}

	// Verify it's gone
	w2, _ := db.GetMiBandWorkout(context.Background(), workoutID)
	if w2 != nil {
		t.Errorf("expected workout to be deleted")
	}
}

func TestUpdateMiBandWorkoutHandler(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()
	userID := srv.allowedUserID

	// Setup a workout
	startMs := time.Now().UnixMilli()
	workouts := []store.MiBandWorkout{
		{
			UserID: userID, SourceStartMs: startMs, SourceEndMs: startMs + 1000,
			ActivityType: 1, ActivityName: "test", DurationSec: 1, DistanceM: 10,
			Steps: 0, Calories: 0,
		},
	}
	_, _, err := db.ImportMiBandWorkouts(context.Background(), workouts, nil)
	if err != nil {
		t.Fatalf("import: %v", err)
	}

	result, _ := db.ListMiBandWorkouts(context.Background(), userID, 1)
	if len(result) != 1 {
		t.Fatalf("expected 1 workout")
	}
	workoutID := result[0].ID

	// Update the workout
	newSteps := 1000
	newDist := 5000.0
	payload := map[string]interface{}{
		"steps":      newSteps,
		"distance_m": newDist,
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest("PATCH", "/api/workout/miband/"+strconv.FormatInt(workoutID, 10), bytes.NewReader(body))
	req.SetPathValue("id", strconv.FormatInt(workoutID, 10))
	w := httptest.NewRecorder()
	srv.handleUpdateMiBandWorkout(w, withUser(req, userID))

	if w.Code != http.StatusOK {
		t.Errorf("expected 200 OK, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Verify changes
	updated, _ := db.GetMiBandWorkout(context.Background(), workoutID)
	if updated.Steps != newSteps {
		t.Errorf("expected %d steps, got %d", newSteps, updated.Steps)
	}
	if updated.DistanceM != newDist {
		t.Errorf("expected %f dist, got %f", newDist, updated.DistanceM)
	}
}
