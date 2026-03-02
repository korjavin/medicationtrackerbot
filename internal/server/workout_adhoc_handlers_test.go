package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func TestHandleCreateAdHocWorkoutSession(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("POST", "/api/workout/sessions/adhoc", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateAdHocWorkoutSession(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("Expected 201, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Session     *store.WorkoutSession `json:"session"`
		GroupName   string                `json:"group_name"`
		VariantName string                `json:"variant_name"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("Decode error: %v", err)
	}

	if resp.Session == nil {
		t.Fatal("Expected non-nil session in response")
	}
	if resp.Session.ID == 0 {
		t.Error("Expected non-zero session ID")
	}
	if resp.Session.GroupID != -1 {
		t.Errorf("Expected GroupID=-1 for ad-hoc session, got %d", resp.Session.GroupID)
	}
	if resp.Session.Status != "in_progress" {
		t.Errorf("Expected status='in_progress', got %q", resp.Session.Status)
	}
	if resp.GroupName != "Ad-hoc Workout" {
		t.Errorf("Expected GroupName='Ad-hoc Workout', got %q", resp.GroupName)
	}
}

func TestHandleCreateAdHocWorkoutSession_PersistsInDB(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("POST", "/api/workout/sessions/adhoc", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateAdHocWorkoutSession(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("Expected 201, got %d", w.Code)
	}

	var resp struct {
		Session *store.WorkoutSession `json:"session"`
	}
	json.NewDecoder(w.Body).Decode(&resp)

	// Verify session exists in DB
	sessionInDB, err := db.GetWorkoutSession(resp.Session.ID)
	if err != nil {
		t.Fatalf("GetWorkoutSession: %v", err)
	}
	if sessionInDB == nil {
		t.Fatal("Session not found in DB")
	}
	if sessionInDB.GroupID != -1 {
		t.Errorf("Expected ad-hoc GroupID=-1 in DB, got %d", sessionInDB.GroupID)
	}
	if sessionInDB.StartedAt == nil {
		t.Error("Expected StartedAt to be set for ad-hoc session")
	}
}
