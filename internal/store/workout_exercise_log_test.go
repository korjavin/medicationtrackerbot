package store

import (
	"testing"
	"time"
)

func TestGetExerciseLogBySessionAndExercise(t *testing.T) {
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	defer db.Close()

	userID := int64(123456)
	group, _ := db.CreateWorkoutGroup("Group", "Desc", false, userID, "[]", "10:00", 15)
	variant, _ := db.CreateWorkoutVariant(group.ID, "Variant", nil, "")
	ex1, _ := db.AddExerciseToVariant(variant.ID, "Pushups", 3, 10, nil, nil, 0)
	ex2, _ := db.AddExerciseToVariant(variant.ID, "Squats", 3, 10, nil, nil, 1)
	session, _ := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "10:00")

	// No logs yet — should return nil
	log, err := db.GetExerciseLogBySessionAndExercise(session.ID, ex1.ID)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if log != nil {
		t.Fatal("Expected nil log for exercise with no entry")
	}

	// Log exercise 1
	sets := 3
	reps := 10
	logID, err := db.LogExercise(session.ID, ex1.ID, "Pushups", &sets, &reps, nil, "completed", "")
	if err != nil {
		t.Fatalf("Failed to log exercise: %v", err)
	}

	// Now should find it
	log, err = db.GetExerciseLogBySessionAndExercise(session.ID, ex1.ID)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if log == nil {
		t.Fatal("Expected to find log for exercise 1")
	}
	if log.ID != logID {
		t.Errorf("Expected log ID %d, got %d", logID, log.ID)
	}
	if log.ExerciseName != "Pushups" {
		t.Errorf("Expected exercise name 'Pushups', got %q", log.ExerciseName)
	}

	// Exercise 2 should still return nil
	log, err = db.GetExerciseLogBySessionAndExercise(session.ID, ex2.ID)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if log != nil {
		t.Fatal("Expected nil log for exercise 2")
	}
}

func TestDeleteExerciseLog(t *testing.T) {
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	defer db.Close()

	userID := int64(123456)
	group, _ := db.CreateWorkoutGroup("Group", "Desc", false, userID, "[]", "10:00", 15)
	variant, _ := db.CreateWorkoutVariant(group.ID, "Variant", nil, "")
	ex, _ := db.AddExerciseToVariant(variant.ID, "Pushups", 3, 10, nil, nil, 0)
	session, _ := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "10:00")

	// Create a log
	sets := 3
	reps := 10
	logID, _ := db.LogExercise(session.ID, ex.ID, "Pushups", &sets, &reps, nil, "completed", "")

	// Verify it exists
	logs, _ := db.GetExerciseLogs(session.ID)
	if len(logs) != 1 {
		t.Fatalf("Expected 1 log, got %d", len(logs))
	}

	// Delete it
	err = db.DeleteExerciseLog(logID)
	if err != nil {
		t.Fatalf("Failed to delete log: %v", err)
	}

	// Verify it's gone
	logs, _ = db.GetExerciseLogs(session.ID)
	if len(logs) != 0 {
		t.Fatalf("Expected 0 logs after delete, got %d", len(logs))
	}

	// Lookup should also return nil
	log, _ := db.GetExerciseLogBySessionAndExercise(session.ID, ex.ID)
	if log != nil {
		t.Fatal("Expected nil after delete")
	}
}

func TestIdempotentExerciseLogging(t *testing.T) {
	// Simulates the scenario: TG bot logs exercise, then user edits on web,
	// then TG bot tries to log again — should not create duplicate.
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	defer db.Close()

	userID := int64(123456)
	group, _ := db.CreateWorkoutGroup("Group", "Desc", false, userID, "[]", "10:00", 15)
	variant, _ := db.CreateWorkoutVariant(group.ID, "Variant", nil, "")
	ex, _ := db.AddExerciseToVariant(variant.ID, "Bench Press", 4, 8, nil, nil, 0)
	session, _ := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "10:00")

	sets := 4
	reps := 8

	// First log (simulates web save)
	_, err = db.LogExercise(session.ID, ex.ID, "Bench Press", &sets, &reps, nil, "completed", "")
	if err != nil {
		t.Fatalf("Failed first log: %v", err)
	}

	// Simulate TG bot checking before logging (idempotent pattern)
	existing, err := db.GetExerciseLogBySessionAndExercise(session.ID, ex.ID)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if existing == nil {
		t.Fatal("Expected to find existing log — idempotent check failed")
	}

	// TG bot should update existing instead of inserting
	newReps := 10
	err = db.UpdateExerciseLog(existing.ID, &sets, &newReps, nil, "updated from TG")
	if err != nil {
		t.Fatalf("Failed to update existing log: %v", err)
	}

	// Verify only ONE log exists (no duplicate)
	logs, _ := db.GetExerciseLogs(session.ID)
	if len(logs) != 1 {
		t.Fatalf("Expected exactly 1 log (no duplicate), got %d", len(logs))
	}
	if *logs[0].RepsCompleted != 10 {
		t.Errorf("Expected updated reps 10, got %d", *logs[0].RepsCompleted)
	}
	if logs[0].Notes != "updated from TG" {
		t.Errorf("Expected updated notes, got %q", logs[0].Notes)
	}
}
