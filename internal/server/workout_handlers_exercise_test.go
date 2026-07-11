package server

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	workoutsvc "github.com/korjavin/medicationtrackerbot/internal/domain/workout"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func TestHandleGetUniqueExercises(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	defer db.Close()

	srv := &Server{workouts: db.Workout, allowedUserID: 123456}
	userID := int64(123456)

	// Create group and variant
	group, _ := db.Workout.CreateGroup("Group", "Desc", false, userID, "[]", "10:00", 15)
	variant, _ := db.Workout.CreateVariant(group.ID, "Variant", nil, "")

	db.Workout.CreateExerciseInVariant(variant.ID, "Pushups", 3, 10, nil, nil, 0)
	db.Workout.CreateExerciseInVariant(variant.ID, "Squats", 3, 10, nil, nil, 1)

	req := withUser(httptest.NewRequest(http.MethodGet, "/api/workout/exercises/unique", nil), userID)
	w := httptest.NewRecorder()
	srv.handleGetUniqueExercises(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected 200, got %d", w.Code)
	}
}

// TestExerciseLibraryReference_CreateDedupeRename is the Go half of the
// cross-mode contract-parity test (med-prk.2, plan Task 6): create plan
// exercise "Bench" twice (dedupe to one library row) then rename the library
// row to "Bench Press" and assert the plan-exercise reads follow the rename
// through the exercise_library_id FK. The shim half lives in
// web/static/js/tests/cloud.shim-contract.workout-crud.test.js.
func TestExerciseLibraryReference_CreateDedupeRename(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	defer db.Close()

	userID := int64(123456)
	group, _ := db.Workout.CreateGroup("Group", "Desc", false, userID, "[]", "10:00", 15)
	variantA, _ := db.Workout.CreateVariant(group.ID, "A", nil, "")
	variantB, _ := db.Workout.CreateVariant(group.ID, "B", nil, "")

	exA, err := db.Workout.CreateExerciseInVariant(variantA.ID, "Bench", 3, 8, nil, nil, 0)
	if err != nil {
		t.Fatalf("create exercise A: %v", err)
	}
	exB, err := db.Workout.CreateExerciseInVariant(variantB.ID, "Bench", 5, 3, nil, nil, 0)
	if err != nil {
		t.Fatalf("create exercise B: %v", err)
	}

	// (a) exactly one library row for the duplicated name, and both plan
	// exercises reference it.
	lib, _ := db.Workout.ListExerciseLibrary(userID)
	var benchRows int
	var libID int64
	for _, item := range lib {
		if item.Name == "Bench" {
			benchRows++
			libID = item.ID
		}
	}
	if benchRows != 1 {
		t.Fatalf("expected exactly 1 library row for 'Bench', got %d", benchRows)
	}
	if exA.ExerciseLibraryID == nil || *exA.ExerciseLibraryID != libID {
		t.Fatalf("exercise A not linked to library row %d: %+v", libID, exA.ExerciseLibraryID)
	}
	if exB.ExerciseLibraryID == nil || *exB.ExerciseLibraryID != libID {
		t.Fatalf("exercise B not linked to library row %d: %+v", libID, exB.ExerciseLibraryID)
	}

	// (b) renaming the library row shows through in both plans' reads.
	if err := db.Workout.UpdateExerciseLibraryItem(userID, libID, "Bench Press", 3, 8, nil, nil, ""); err != nil {
		t.Fatalf("rename library item: %v", err)
	}
	for _, v := range []int64{variantA.ID, variantB.ID} {
		exs, _ := db.Workout.ListExercisesByVariant(v)
		if len(exs) != 1 {
			t.Fatalf("variant %d: expected 1 exercise, got %d", v, len(exs))
		}
		if exs[0].ExerciseName != "Bench Press" {
			t.Errorf("variant %d: expected 'Bench Press' after rename, got %q", v, exs[0].ExerciseName)
		}
	}
	after, _ := db.Workout.ListExerciseLibrary(userID)
	if len(after) != 1 || after[0].Name != "Bench Press" {
		t.Errorf("expected 1 library row 'Bench Press', got %+v", after)
	}

	// (c) another user cannot rename or delete this user's library row — the
	// operations are user-scoped (else a stranger's rename would propagate into
	// these plans via the FK). Both return sql.ErrNoRows and change nothing.
	otherUser := int64(999999)
	if err := db.Workout.UpdateExerciseLibraryItem(otherUser, libID, "Hacked", 3, 8, nil, nil, ""); err != sql.ErrNoRows {
		t.Fatalf("cross-user update: expected sql.ErrNoRows, got %v", err)
	}
	if err := db.Workout.DeleteExerciseLibraryItem(otherUser, libID); err != sql.ErrNoRows {
		t.Fatalf("cross-user delete: expected sql.ErrNoRows, got %v", err)
	}
	still, _ := db.Workout.ListExerciseLibrary(userID)
	if len(still) != 1 || still[0].Name != "Bench Press" {
		t.Fatalf("cross-user ops mutated the library: %+v", still)
	}

	// (d) deleting the referenced library row snapshots its current name into the
	// plans and drops the FK — no revert to a stale cached name, no dangling ref.
	if err := db.Workout.DeleteExerciseLibraryItem(userID, libID); err != nil {
		t.Fatalf("owner delete: %v", err)
	}
	for _, v := range []int64{variantA.ID, variantB.ID} {
		exs, _ := db.Workout.ListExercisesByVariant(v)
		if len(exs) != 1 || exs[0].ExerciseName != "Bench Press" || exs[0].ExerciseLibraryID != nil {
			t.Errorf("variant %d after library delete: want name 'Bench Press' + nil FK, got %+v", v, exs)
		}
	}
}

func TestHandleAddExerciseToSession(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	defer db.Close()

	srv := &Server{workouts: db.Workout, workoutSvc: workoutsvc.New(db.Workout, db.TZ), allowedUserID: 123456}
	userID := int64(123456)
	otherUserID := int64(999999)

	// Setup
	group, _ := db.Workout.CreateGroup("Group", "Desc", false, userID, "[]", "10:00", 15)
	variant, _ := db.Workout.CreateVariant(group.ID, "Variant", nil, "")
	ex, _ := db.Workout.CreateExerciseInVariant(variant.ID, "Burpees", 3, 10, nil, nil, 0)
	session, _ := db.Workout.CreateSession(group.ID, variant.ID, userID, time.Now(), "10:00")

	// Setup other user session
	group2, _ := db.Workout.CreateGroup("Group 2", "Desc", false, otherUserID, "[]", "10:00", 15)
	variant2, _ := db.Workout.CreateVariant(group2.ID, "Variant 2", nil, "")
	session2, _ := db.Workout.CreateSession(group2.ID, variant2.ID, otherUserID, time.Now(), "10:00")

	// Test adding exercise - Success
	payload := map[string]interface{}{
		"session_id":       session.ID,
		"exercise_id":      ex.ID,
		"exercise_name":    "Burpees",
		"target_sets":      5,
		"target_reps_min":  20,
		"target_weight_kg": 0,
		"status":           "completed",
		"notes":            "Extra hard",
	}
	body, _ := json.Marshal(payload)
	req := withUser(httptest.NewRequest(http.MethodPost, "/api/workout/sessions/logs/create", bytes.NewReader(body)), userID)
	w := httptest.NewRecorder()

	srv.handleAddExerciseToSession(w, req)

	if w.Code != http.StatusCreated {
		t.Errorf("Expected 201, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Test adding exercise - Forbidden (wrong user)
	payloadForbidden := map[string]interface{}{
		"session_id":      session2.ID, // Owned by otherUserID
		"exercise_id":     ex.ID,
		"exercise_name":   "Burpees",
		"target_sets":     5,
		"target_reps_min": 20,
		"status":          "completed",
	}
	bodyForbidden, _ := json.Marshal(payloadForbidden)
	reqForbidden := withUser(httptest.NewRequest(http.MethodPost, "/api/workout/sessions/logs/create", bytes.NewReader(bodyForbidden)), userID)
	wForbidden := httptest.NewRecorder()

	srv.handleAddExerciseToSession(wForbidden, reqForbidden)

	if wForbidden.Code != http.StatusForbidden {
		t.Errorf("Expected 403 Forbidden, got %d. Body: %s", wForbidden.Code, wForbidden.Body.String())
	}
}
