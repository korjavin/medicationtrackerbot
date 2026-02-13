package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func TestHandleUpdateSessionStatus(t *testing.T) {
	// Create test database
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	defer db.Close()

	// Create test server
	srv := &Server{
		store:         db,
		allowedUserID: 123456,
	}

	// Create test user, medication, and workout structures
	userID := int64(123456)

	// Create workout group
	group, err := db.CreateWorkoutGroup("Test Group", "Test", false, userID, "[1,2,3,4,5]", "09:00", 15)
	if err != nil {
		t.Fatalf("Failed to create workout group: %v", err)
	}

	// Create variant
	rotationOrder := 0
	variant, err := db.CreateWorkoutVariant(group.ID, "Test Variant", &rotationOrder, "")
	if err != nil {
		t.Fatalf("Failed to create workout variant: %v", err)
	}

	// Create a workout session
	scheduledDate := time.Now()
	session, err := db.CreateWorkoutSession(group.ID, variant.ID, userID, scheduledDate, "09:00")
	if err != nil {
		t.Fatalf("Failed to create workout session: %v", err)
	}

	// Initially set status to completed
	err = db.UpdateSessionStatus(session.ID, "completed")
	if err != nil {
		t.Fatalf("Failed to set initial status: %v", err)
	}

	tests := []struct {
		name           string
		sessionID      int64
		reqBody        map[string]string
		expectedStatus int
		expectedError  string
		finalStatus    string
	}{
		{
			name:           "Valid status update to skipped",
			sessionID:      session.ID,
			reqBody:        map[string]string{"status": "skipped"},
			expectedStatus: http.StatusOK,
			finalStatus:    "skipped",
		},
		{
			name:           "Valid status update to completed",
			sessionID:      session.ID,
			reqBody:        map[string]string{"status": "completed"},
			expectedStatus: http.StatusOK,
			finalStatus:    "completed",
		},
		{
			name:           "Invalid status value",
			sessionID:      session.ID,
			reqBody:        map[string]string{"status": "pending"},
			expectedStatus: http.StatusBadRequest,
			expectedError:  "Invalid status",
		},
		{
			name:           "Invalid status value - in_progress",
			sessionID:      session.ID,
			reqBody:        map[string]string{"status": "in_progress"},
			expectedStatus: http.StatusBadRequest,
			expectedError:  "Invalid status",
		},
		{
			name:           "Non-existent session ID",
			sessionID:      99999,
			reqBody:        map[string]string{"status": "completed"},
			expectedStatus: http.StatusNotFound,
		},
		{
			name:           "Session ID 0",
			sessionID:      0,
			reqBody:        map[string]string{"status": "completed"},
			expectedStatus: http.StatusNotFound,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Prepare request body
			bodyBytes, _ := json.Marshal(tt.reqBody)
			url := fmt.Sprintf("/api/workout/sessions/status?id=%d", tt.sessionID)
			req := httptest.NewRequest(http.MethodPut, url, bytes.NewReader(bodyBytes))

			w := httptest.NewRecorder()

			// Call handler
			srv.handleUpdateSessionStatus(w, req)

			// Check status code
			if w.Code != tt.expectedStatus {
				t.Errorf("Expected status %d, got %d. Body: %s", tt.expectedStatus, w.Code, w.Body.String())
			}

			// Check error message if expected
			if tt.expectedError != "" && !bytes.Contains(w.Body.Bytes(), []byte(tt.expectedError)) {
				t.Errorf("Expected error containing %q, got %q", tt.expectedError, w.Body.String())
			}

			// Verify final status if test should succeed
			if tt.expectedStatus == http.StatusOK && tt.finalStatus != "" {
				updatedSession, err := db.GetWorkoutSession(session.ID)
				if err != nil {
					t.Fatalf("Failed to get updated session: %v", err)
				}
				if updatedSession.Status != tt.finalStatus {
					t.Errorf("Expected final status %q, got %q", tt.finalStatus, updatedSession.Status)
				}
			}
		})
	}
}

func TestHandleGetNextWorkout_LazyCreation(t *testing.T) {
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

	// Create workout group active every day at 23:59 (to ensure it's in future for today, or definitely tomorrow)
	// We want to test that it picks up *some* future workout.
	// We'll use tomorrow to be safe from "time passed today" logic.
	group, err := db.CreateWorkoutGroup("Everyday Group", "Test", false, userID, "[0,1,2,3,4,5,6]", "23:59", 15)
	if err != nil {
		t.Fatalf("Failed to create workout group: %v", err)
	}

	// Create variant
	rotationOrder := 0
	_, err = db.CreateWorkoutVariant(group.ID, "Variant A", &rotationOrder, "")
	if err != nil {
		t.Fatalf("Failed to create workout variant: %v", err)
	}

	// Verify NO sessions exist initially
	sessions, err := db.GetWorkoutHistory(userID, 100)
	if err != nil {
		t.Fatalf("Failed to get history: %v", err)
	}
	if len(sessions) != 0 {
		t.Errorf("Expected 0 sessions initially, got %d", len(sessions))
	}

	// Call handleGetNextWorkout
	req := httptest.NewRequest(http.MethodGet, "/api/workout/sessions/next", nil)
	w := httptest.NewRecorder()

	srv.handleGetNextWorkout(w, req)

	// Check status code
	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Parse response
	var resp struct {
		Session struct {
			ID            int64  `json:"id"`
			Status        string `json:"status"`
			ScheduledTime string `json:"scheduled_time"`
		} `json:"session"`
		GroupName string `json:"group_name"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}

	// Verify session ID is not 0
	if resp.Session.ID == 0 {
		t.Error("Expected session ID > 0, got 0")
	}

	// Verify session was created in DB
	// Check history again
	sessions, err = db.GetWorkoutHistory(userID, 100)
	if err != nil {
		t.Fatalf("Failed to get history: %v", err)
	}
	if len(sessions) != 1 {
		t.Errorf("Expected 1 session created, got %d", len(sessions))
	} else {
		createdSession := sessions[0]
		if createdSession.ID != resp.Session.ID {
			t.Errorf("DB session ID %d does not match response ID %d", createdSession.ID, resp.Session.ID)
		}
		if createdSession.GroupID != group.ID {
			t.Errorf("Expected group ID %d, got %d", group.ID, createdSession.GroupID)
		}
		// Status should be pending
		if createdSession.Status != "pending" {
			t.Errorf("Expected status 'pending', got %q", createdSession.Status)
		}
	}
}
