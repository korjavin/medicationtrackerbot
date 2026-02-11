package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func TestHandleGetNextWorkout_CompletedSession(t *testing.T) {
	// Create test database
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	defer db.Close()

	// Create test server
	userID := int64(123456)
	srv := &Server{
		store:         db,
		allowedUserID: userID,
	}

	// Create workout group active every day at future time (late enough to likely be today)
	// Using 23:59 to avoid "rolling into tomorrow" flake near midnight
	timeStr := "23:59"

	group, err := db.CreateWorkoutGroup("Daily Workout", "Test", false, userID, "[0,1,2,3,4,5,6]", timeStr, 15)
	if err != nil {
		t.Fatalf("Failed to create workout group: %v", err)
	}

	// Create variant
	rotationOrder := 0
	variant, err := db.CreateWorkoutVariant(group.ID, "Variant A", &rotationOrder, "")
	if err != nil {
		t.Fatalf("Failed to create workout variant: %v", err)
	}

	// Scenario 1: User completed today's workout early (which is still scheduled in future)
	// Create a session for today that is COMPLETED
	now := time.Now()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	session, err := db.CreateWorkoutSession(group.ID, variant.ID, userID, today, timeStr)
	if err != nil {
		t.Fatalf("Failed to create workout session: %v", err)
	}

	err = db.CompleteSession(session.ID)
	if err != nil {
		t.Fatalf("Failed to complete session: %v", err)
	}

	// Call handleGetNextWorkout
	// We expect to see TOMORROW'S workout (or nothing if outside window), not today's completed one.
	req := httptest.NewRequest(http.MethodGet, "/api/workout/sessions/next", nil)
	w := httptest.NewRecorder()

	srv.handleGetNextWorkout(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	var resp *struct {
		Session struct {
			ID            int64  `json:"id"`
			Status        string `json:"status"`
			ScheduledDate string `json:"scheduled_date"`
		} `json:"session"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		// It might return nil (null) which is valid JSON, Decode deals with it if we point to pointer?
		// No, Decode won't error on "null", but we need to check if resp is nil or fields empty.
	}

	// If resp is nil, or session is empty, that's fine (means no next workout found).
	// But if it found the COMPLETED session, that's a bug.
	if resp != nil && resp.Session.ID == session.ID {
		t.Errorf("FAIL: Got completed session ID %d as next workout", session.ID)
	}
}

func TestHandleGetNextWorkout_SnoozedThenCompleted(t *testing.T) {
	// Create test database
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	defer db.Close()

	// Create test server
	userID := int64(123456)
	srv := &Server{
		store:         db,
		allowedUserID: userID,
	}

	// Create workout group
	group, err := db.CreateWorkoutGroup("Daily Workout", "Test", false, userID, "[0,1,2,3,4,5,6]", "09:00", 15)
	if err != nil {
		t.Fatalf("Failed to create workout group: %v", err)
	}

	// Create variant
	rotationOrder := 0
	variant, err := db.CreateWorkoutVariant(group.ID, "Variant A", &rotationOrder, "")
	if err != nil {
		t.Fatalf("Failed to create workout variant: %v", err)
	}

	// Create a session for today
	now := time.Now()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	session, err := db.CreateWorkoutSession(group.ID, variant.ID, userID, today, "09:00")
	if err != nil {
		t.Fatalf("Failed to create workout session: %v", err)
	}

	// Snooze it - snoozed until simple past so it would be picked up
	err = db.SnoozeSession(session.ID, -1*time.Hour)
	if err != nil {
		t.Fatalf("Failed to snooze session: %v", err)
	}

	// Complete it (simulating user completed it via bot or another device while snoozed)
	err = db.CompleteSession(session.ID)
	if err != nil {
		t.Fatalf("Failed to complete session: %v", err)
	}

	// Verify it is actually completed in DB
	s, _ := db.GetWorkoutSession(session.ID)
	if s.Status != "completed" {
		t.Fatalf("Session status is %s, expected completed", s.Status)
	}

	// Call handleGetNextWorkout
	// The snooze logic might pick it up because it has a snoozed_until time <= now
	// We expect it to NOT be returned as next workout if it is completed.
	req := httptest.NewRequest(http.MethodGet, "/api/workout/sessions/next", nil)
	w := httptest.NewRecorder()

	srv.handleGetNextWorkout(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	var resp *struct {
		Session struct {
			ID     int64  `json:"id"`
			Status string `json:"status"`
		} `json:"session"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}

	if resp != nil && resp.Session.ID == session.ID {
		t.Errorf("FAIL: Got snoozed+completed session ID %d as next workout", session.ID)
	}
}
