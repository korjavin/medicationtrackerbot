package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func TestHandleListWorkoutSessions_AdHocNames(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)

	// Create a regular (non-ad-hoc) session for comparison
	group, err := db.CreateWorkoutGroup("Legs", "Leg day", false, userID, "[1,2,3]", "10:00", 15)
	if err != nil {
		t.Fatalf("CreateWorkoutGroup: %v", err)
	}
	rotOrder := 0
	variant, err := db.CreateWorkoutVariant(group.ID, "Heavy", &rotOrder, "")
	if err != nil {
		t.Fatalf("CreateWorkoutVariant: %v", err)
	}
	regularSession, err := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "10:00")
	if err != nil {
		t.Fatalf("CreateWorkoutSession: %v", err)
	}
	_ = regularSession

	// Create an ad-hoc session with two exercises; Squats has bigger volume
	adHocSession, err := db.CreateAdHocWorkoutSession(userID, time.Now(), "11:00")
	if err != nil {
		t.Fatalf("CreateAdHocWorkoutSession: %v", err)
	}
	sets1 := 3
	reps1 := 10
	w1 := 100.0 // Squats: vol = 3000
	_, err = db.LogExercise(adHocSession.ID, 0, "Squats", &sets1, &reps1, &w1, "completed", "")
	if err != nil {
		t.Fatalf("LogExercise Squats: %v", err)
	}
	sets2 := 3
	reps2 := 10
	w2 := 50.0 // Bench: vol = 1500
	_, err = db.LogExercise(adHocSession.ID, 0, "Bench Press", &sets2, &reps2, &w2, "completed", "")
	if err != nil {
		t.Fatalf("LogExercise Bench: %v", err)
	}

	// Create an ad-hoc session with no logged exercises
	emptyAdHocSession, err := db.CreateAdHocWorkoutSession(userID, time.Now(), "12:00")
	if err != nil {
		t.Fatalf("CreateAdHocWorkoutSession empty: %v", err)
	}
	_ = emptyAdHocSession

	// Call the handler
	req := httptest.NewRequest("GET", "/api/workout/sessions?limit=10", nil)
	req = withUser(req, userID)
	w := httptest.NewRecorder()
	srv.handleListWorkoutSessions(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d: %s", w.Code, w.Body.String())
	}

	type enrichedResp struct {
		Session     *store.WorkoutSession `json:"session"`
		GroupName   string                `json:"group_name"`
		VariantName string                `json:"variant_name"`
		Exercises   int                   `json:"exercises_count"`
		Completed   int                   `json:"exercises_completed"`
	}
	var results []enrichedResp
	if err := json.NewDecoder(w.Body).Decode(&results); err != nil {
		t.Fatalf("Decode: %v", err)
	}

	if len(results) != 3 {
		t.Fatalf("Expected 3 sessions, got %d", len(results))
	}

	// Find sessions by GroupID
	var regular, withExercises, empty *enrichedResp
	for i := range results {
		r := &results[i]
		if r.Session == nil {
			t.Fatalf("nil session in result %d", i)
		}
		switch r.Session.ID {
		case regularSession.ID:
			regular = r
		case adHocSession.ID:
			withExercises = r
		case emptyAdHocSession.ID:
			empty = r
		}
	}

	if regular == nil {
		t.Fatal("regular session not found in results")
	}
	if withExercises == nil {
		t.Fatal("ad-hoc session with exercises not found in results")
	}
	if empty == nil {
		t.Fatal("empty ad-hoc session not found in results")
	}

	// Regular session should have group/variant names from DB
	if regular.GroupName != "Legs" {
		t.Errorf("regular: expected GroupName='Legs', got %q", regular.GroupName)
	}
	if regular.VariantName != "Heavy" {
		t.Errorf("regular: expected VariantName='Heavy', got %q", regular.VariantName)
	}

	// Ad-hoc with exercises: group='Ad-hoc', variant=biggest by volume='Squats'
	if withExercises.GroupName != "Ad-hoc" {
		t.Errorf("ad-hoc: expected GroupName='Ad-hoc', got %q", withExercises.GroupName)
	}
	if withExercises.VariantName != "Squats" {
		t.Errorf("ad-hoc: expected VariantName='Squats' (biggest volume), got %q", withExercises.VariantName)
	}
	if withExercises.Exercises != 2 {
		t.Errorf("ad-hoc: expected exercises_count=2, got %d", withExercises.Exercises)
	}
	if withExercises.Completed != 2 {
		t.Errorf("ad-hoc: expected exercises_completed=2, got %d", withExercises.Completed)
	}

	// Ad-hoc with no exercises: group='Ad-hoc', variant='', counts=0
	if empty.GroupName != "Ad-hoc" {
		t.Errorf("empty ad-hoc: expected GroupName='Ad-hoc', got %q", empty.GroupName)
	}
	if empty.VariantName != "" {
		t.Errorf("empty ad-hoc: expected VariantName='', got %q", empty.VariantName)
	}
	if empty.Exercises != 0 {
		t.Errorf("empty ad-hoc: expected exercises_count=0, got %d", empty.Exercises)
	}
	if empty.Completed != 0 {
		t.Errorf("empty ad-hoc: expected exercises_completed=0, got %d", empty.Completed)
	}
}
