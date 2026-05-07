package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func TestHandleScheduleAdHocWorkoutSession_HappyPath(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	tomorrow := time.Now().AddDate(0, 0, 1).Format("2006-01-02")
	body := map[string]any{
		"scheduled_date": tomorrow,
		"scheduled_time": "07:30",
		"exercises": []map[string]any{
			{"exercise_name": "Bench Press", "target_sets": 4, "target_reps_min": 6, "target_reps_max": 8, "target_weight_kg": 70.0},
			{"exercise_name": "Pull-ups", "target_sets": 3, "target_reps_min": 8},
		},
	}
	bodyBytes, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/workout/sessions/schedule", bytes.NewReader(bodyBytes))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleScheduleAdHocWorkoutSession(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("Expected 201, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Session *store.WorkoutSession `json:"session"`
		Planned int                   `json:"planned"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("Decode error: %v", err)
	}
	if resp.Session == nil {
		t.Fatal("Expected non-nil session in response")
	}
	if resp.Session.GroupID != -1 || resp.Session.VariantID != -1 {
		t.Errorf("Expected ad-hoc sentinels GroupID=-1 VariantID=-1, got GroupID=%d VariantID=%d", resp.Session.GroupID, resp.Session.VariantID)
	}
	if resp.Session.Status != "pending" {
		t.Errorf("Expected status='pending', got %q", resp.Session.Status)
	}
	if resp.Session.StartedAt != nil {
		t.Errorf("Expected StartedAt to be nil for scheduled ad-hoc, got %v", resp.Session.StartedAt)
	}
	if resp.Planned != 2 {
		t.Errorf("Expected planned=2, got %d", resp.Planned)
	}

	logs, err := db.GetExerciseLogs(resp.Session.ID)
	if err != nil {
		t.Fatalf("GetExerciseLogs: %v", err)
	}
	if len(logs) != 2 {
		t.Fatalf("Expected 2 exercise log placeholders, got %d", len(logs))
	}
	for _, l := range logs {
		if l.Status != "" {
			t.Errorf("Expected placeholder log status='' (pending), got %q", l.Status)
		}
		if l.SetsCompleted != nil || l.RepsCompleted != nil || l.WeightKg != nil {
			t.Errorf("Expected NULL completion fields on placeholder log, got sets=%v reps=%v weight=%v", l.SetsCompleted, l.RepsCompleted, l.WeightKg)
		}
	}
}

func TestHandleScheduleAdHocWorkoutSession_RejectsPastDate(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	yesterday := time.Now().AddDate(0, 0, -1).Format("2006-01-02")
	body := map[string]any{
		"scheduled_date": yesterday,
		"scheduled_time": "07:30",
		"exercises": []map[string]any{
			{"exercise_name": "Bench Press", "target_sets": 3, "target_reps_min": 8},
		},
	}
	bodyBytes, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/workout/sessions/schedule", bytes.NewReader(bodyBytes))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleScheduleAdHocWorkoutSession(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("Expected 400 for past date, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(strings.ToLower(w.Body.String()), "future") {
		t.Errorf("Expected error message to mention 'future', got %q", w.Body.String())
	}
}

func TestHandleScheduleAdHocWorkoutSession_RejectsEmptyExercises(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	tomorrow := time.Now().AddDate(0, 0, 1).Format("2006-01-02")
	body := map[string]any{
		"scheduled_date": tomorrow,
		"scheduled_time": "07:30",
		"exercises":      []map[string]any{},
	}
	bodyBytes, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/workout/sessions/schedule", bytes.NewReader(bodyBytes))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleScheduleAdHocWorkoutSession(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("Expected 400 for empty exercises, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(strings.ToLower(w.Body.String()), "empty") {
		t.Errorf("Expected error message to mention 'empty', got %q", w.Body.String())
	}
}

func TestHandleScheduleAdHocWorkoutSession_RejectsBadDateFormat(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	body := map[string]any{
		"scheduled_date": "2026/05/10",
		"scheduled_time": "07:30",
		"exercises": []map[string]any{
			{"exercise_name": "Bench Press", "target_sets": 3, "target_reps_min": 8},
		},
	}
	bodyBytes, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/workout/sessions/schedule", bytes.NewReader(bodyBytes))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleScheduleAdHocWorkoutSession(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("Expected 400 for bad date format, got %d: %s", w.Code, w.Body.String())
	}
}

func TestHandleScheduleAdHocWorkoutSession_RequiresAuth(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	bodyBytes, _ := json.Marshal(map[string]any{})
	req := httptest.NewRequest(http.MethodPost, "/api/workout/sessions/schedule", bytes.NewReader(bodyBytes))
	w := httptest.NewRecorder()

	srv.handleScheduleAdHocWorkoutSession(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("Expected 401 without user, got %d", w.Code)
	}
}
