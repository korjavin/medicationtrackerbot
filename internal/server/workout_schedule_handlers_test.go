package server

import (
	"bytes"
	"encoding/json"
	"fmt"
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

func TestHandleScheduleAdHocWorkoutSession_RejectsDuplicateExerciseID(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	// The handler now resolves exercise_id against the user's library; pre-seed
	// a row so the duplicate check (not the lookup) is what rejects the request.
	libItem, err := db.CreateExerciseLibraryItem(123456, "Bench Press", 3, 6, nil, nil, "")
	if err != nil {
		t.Fatalf("CreateExerciseLibraryItem: %v", err)
	}

	tomorrow := time.Now().AddDate(0, 0, 1).Format("2006-01-02")
	body := map[string]any{
		"scheduled_date": tomorrow,
		"scheduled_time": "07:30",
		"exercises": []map[string]any{
			{"exercise_id": libItem.ID, "exercise_name": "Bench Press", "target_sets": 3, "target_reps_min": 6},
			{"exercise_id": libItem.ID, "exercise_name": "Bench Press (dup)", "target_sets": 3, "target_reps_min": 6},
		},
	}
	bodyBytes, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/workout/sessions/schedule", bytes.NewReader(bodyBytes))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleScheduleAdHocWorkoutSession(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("Expected 400 for duplicate exercise_id, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(strings.ToLower(w.Body.String()), "unique") {
		t.Errorf("Expected error message to mention 'unique', got %q", w.Body.String())
	}
}

func TestHandleScheduleAdHocWorkoutSession_RejectsDuplicateName(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	tomorrow := time.Now().AddDate(0, 0, 1).Format("2006-01-02")
	body := map[string]any{
		"scheduled_date": tomorrow,
		"scheduled_time": "07:30",
		"exercises": []map[string]any{
			{"exercise_name": "Bench Press", "target_sets": 3, "target_reps_min": 6},
			// Same name with different casing/whitespace must also be caught.
			{"exercise_name": " bench press ", "target_sets": 3, "target_reps_min": 6},
		},
	}
	bodyBytes, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/workout/sessions/schedule", bytes.NewReader(bodyBytes))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleScheduleAdHocWorkoutSession(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("Expected 400 for duplicate exercise name, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(strings.ToLower(w.Body.String()), "unique") {
		t.Errorf("Expected error message to mention 'unique', got %q", w.Body.String())
	}
}

func TestHandleScheduleAdHocWorkoutSession_RejectsLibraryAndFreeFormSameName(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	libItem, err := db.CreateExerciseLibraryItem(123456, "Bench Press", 3, 6, nil, nil, "")
	if err != nil {
		t.Fatalf("CreateExerciseLibraryItem: %v", err)
	}

	tomorrow := time.Now().AddDate(0, 0, 1).Format("2006-01-02")
	body := map[string]any{
		"scheduled_date": tomorrow,
		"scheduled_time": "07:30",
		"exercises": []map[string]any{
			// Resolves to library name "Bench Press"
			{"exercise_id": libItem.ID, "target_sets": 3, "target_reps_min": 6},
			// Free-form with the same name — must be rejected.
			{"exercise_name": "Bench Press", "target_sets": 3, "target_reps_min": 6},
		},
	}
	bodyBytes, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/workout/sessions/schedule", bytes.NewReader(bodyBytes))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleScheduleAdHocWorkoutSession(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("Expected 400 for library-id + free-form duplicate name, got %d: %s", w.Code, w.Body.String())
	}
}

func TestHandleScheduleAdHocWorkoutSession_RejectsTooManyExercises(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	tomorrow := time.Now().AddDate(0, 0, 1).Format("2006-01-02")
	exercises := make([]map[string]any, 0, maxScheduledExercises+1)
	for i := 0; i < maxScheduledExercises+1; i++ {
		exercises = append(exercises, map[string]any{
			"exercise_name":   fmt.Sprintf("Exercise %d", i),
			"target_sets":     1,
			"target_reps_min": 1,
		})
	}
	body := map[string]any{
		"scheduled_date": tomorrow,
		"scheduled_time": "07:30",
		"exercises":      exercises,
	}
	bodyBytes, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/workout/sessions/schedule", bytes.NewReader(bodyBytes))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleScheduleAdHocWorkoutSession(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("Expected 400 for too many exercises, got %d: %s", w.Code, w.Body.String())
	}
}

func TestHandleScheduleAdHocWorkoutSession_RejectsRepsMaxLessThanMin(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	tomorrow := time.Now().AddDate(0, 0, 1).Format("2006-01-02")
	body := map[string]any{
		"scheduled_date": tomorrow,
		"scheduled_time": "07:30",
		"exercises": []map[string]any{
			{"exercise_name": "Bench Press", "target_sets": 3, "target_reps_min": 10, "target_reps_max": 6},
		},
	}
	bodyBytes, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/workout/sessions/schedule", bytes.NewReader(bodyBytes))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleScheduleAdHocWorkoutSession(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("Expected 400 for target_reps_max < target_reps_min, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(strings.ToLower(w.Body.String()), "target_reps_max") {
		t.Errorf("Expected error message to mention 'target_reps_max', got %q", w.Body.String())
	}
}

func TestHandleScheduleAdHocWorkoutSession_LibraryIDFillsName(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	libItem, err := db.CreateExerciseLibraryItem(123456, "Squat", 5, 5, nil, nil, "")
	if err != nil {
		t.Fatalf("CreateExerciseLibraryItem: %v", err)
	}

	tomorrow := time.Now().AddDate(0, 0, 1).Format("2006-01-02")
	body := map[string]any{
		"scheduled_date": tomorrow,
		"scheduled_time": "07:30",
		"exercises": []map[string]any{
			// exercise_id only — no exercise_name. The handler should resolve
			// the library item and fill in the name.
			{"exercise_id": libItem.ID, "target_sets": 5, "target_reps_min": 5},
		},
	}
	bodyBytes, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/workout/sessions/schedule", bytes.NewReader(bodyBytes))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleScheduleAdHocWorkoutSession(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("Expected 201 for library-id-only request, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Session *store.WorkoutSession `json:"session"`
		Planned int                   `json:"planned"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("Decode error: %v", err)
	}
	logs, err := db.GetExerciseLogs(resp.Session.ID)
	if err != nil {
		t.Fatalf("GetExerciseLogs: %v", err)
	}
	if len(logs) != 1 {
		t.Fatalf("Expected 1 placeholder log, got %d", len(logs))
	}
	if logs[0].ExerciseName != "Squat" {
		t.Errorf("Expected exercise_name to be filled from library (Squat), got %q", logs[0].ExerciseName)
	}
	if logs[0].ExerciseID != libItem.ID {
		t.Errorf("Expected exercise_id=%d, got %d", libItem.ID, logs[0].ExerciseID)
	}
}

func TestHandleScheduleAdHocWorkoutSession_RejectsUnknownExerciseID(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	tomorrow := time.Now().AddDate(0, 0, 1).Format("2006-01-02")
	body := map[string]any{
		"scheduled_date": tomorrow,
		"scheduled_time": "07:30",
		"exercises": []map[string]any{
			{"exercise_id": 999999, "target_sets": 3, "target_reps_min": 6},
		},
	}
	bodyBytes, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/workout/sessions/schedule", bytes.NewReader(bodyBytes))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleScheduleAdHocWorkoutSession(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("Expected 400 for unknown exercise_id, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(strings.ToLower(w.Body.String()), "library") {
		t.Errorf("Expected error message to mention 'library', got %q", w.Body.String())
	}
}

func TestHandleScheduleAdHocWorkoutSession_RejectsOtherUserLibraryID(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	otherUserID := int64(999000)
	libItem, err := db.CreateExerciseLibraryItem(otherUserID, "Deadlift", 3, 5, nil, nil, "")
	if err != nil {
		t.Fatalf("CreateExerciseLibraryItem: %v", err)
	}

	tomorrow := time.Now().AddDate(0, 0, 1).Format("2006-01-02")
	body := map[string]any{
		"scheduled_date": tomorrow,
		"scheduled_time": "07:30",
		"exercises": []map[string]any{
			{"exercise_id": libItem.ID, "target_sets": 3, "target_reps_min": 5},
		},
	}
	bodyBytes, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/workout/sessions/schedule", bytes.NewReader(bodyBytes))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleScheduleAdHocWorkoutSession(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("Expected 400 when exercise_id belongs to another user, got %d: %s", w.Code, w.Body.String())
	}
}

func TestHandleScheduleAdHocWorkoutSession_RejectsNegativeExerciseID(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	tomorrow := time.Now().AddDate(0, 0, 1).Format("2006-01-02")
	body := map[string]any{
		"scheduled_date": tomorrow,
		"scheduled_time": "07:30",
		"exercises": []map[string]any{
			{"exercise_id": -1, "target_sets": 3, "target_reps_min": 6},
		},
	}
	bodyBytes, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/workout/sessions/schedule", bytes.NewReader(bodyBytes))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleScheduleAdHocWorkoutSession(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("Expected 400 for negative exercise_id, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(strings.ToLower(w.Body.String()), "exercise_id") {
		t.Errorf("Expected error message to mention 'exercise_id', got %q", w.Body.String())
	}
}

func TestHandleScheduleAdHocWorkoutSession_RejectsMissingIDAndName(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	tomorrow := time.Now().AddDate(0, 0, 1).Format("2006-01-02")
	body := map[string]any{
		"scheduled_date": tomorrow,
		"scheduled_time": "07:30",
		"exercises": []map[string]any{
			{"target_sets": 3, "target_reps_min": 6},
		},
	}
	bodyBytes, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/workout/sessions/schedule", bytes.NewReader(bodyBytes))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleScheduleAdHocWorkoutSession(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("Expected 400 when neither exercise_id nor exercise_name supplied, got %d: %s", w.Code, w.Body.String())
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
