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
			expectedStatus: http.StatusOK,
		},
		{
			name:           "Session ID 0",
			sessionID:      0,
			reqBody:        map[string]string{"status": "completed"},
			expectedStatus: http.StatusOK,
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
