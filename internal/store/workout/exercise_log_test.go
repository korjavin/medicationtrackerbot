package workout

import (
	"math"
	"testing"
	"time"
)

func TestGetExerciseLogBySessionAndExercise(t *testing.T) {
	db := setupTestDB(t)

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
	db := setupTestDB(t)

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
	err := db.DeleteExerciseLog(logID)
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
	db := setupTestDB(t)

	userID := int64(123456)
	group, _ := db.CreateWorkoutGroup("Group", "Desc", false, userID, "[]", "10:00", 15)
	variant, _ := db.CreateWorkoutVariant(group.ID, "Variant", nil, "")
	ex, _ := db.AddExerciseToVariant(variant.ID, "Bench Press", 4, 8, nil, nil, 0)
	session, _ := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "10:00")

	sets := 4
	reps := 8

	// First log (simulates web save)
	_, err := db.LogExercise(session.ID, ex.ID, "Bench Press", &sets, &reps, nil, "completed", "")
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

func TestGetExerciseLogByID(t *testing.T) {
	db := setupTestDB(t)

	userID := int64(123456)
	group, _ := db.CreateWorkoutGroup("Group", "Desc", false, userID, "[]", "10:00", 15)
	variant, _ := db.CreateWorkoutVariant(group.ID, "Variant", nil, "")
	ex, _ := db.AddExerciseToVariant(variant.ID, "Pushups", 3, 10, nil, nil, 0)
	session, _ := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "10:00")

	// Non-existent ID returns nil
	log, err := db.GetExerciseLogByID(9999)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if log != nil {
		t.Fatal("Expected nil for non-existent ID")
	}

	// Create a log and fetch by ID
	sets := 3
	reps := 10
	w := 50.0
	logID, _ := db.LogExercise(session.ID, ex.ID, "Pushups", &sets, &reps, &w, "completed", "test notes")

	log, err = db.GetExerciseLogByID(logID)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if log == nil {
		t.Fatal("Expected to find log")
	}
	if log.ID != logID {
		t.Errorf("Expected ID %d, got %d", logID, log.ID)
	}
	if log.SessionID != session.ID {
		t.Errorf("Expected session_id %d, got %d", session.ID, log.SessionID)
	}
	if log.ExerciseID != ex.ID {
		t.Errorf("Expected exercise_id %d, got %d", ex.ID, log.ExerciseID)
	}
	if log.ExerciseName != "Pushups" {
		t.Errorf("Expected exercise name 'Pushups', got %q", log.ExerciseName)
	}
	if log.SetsCompleted == nil || *log.SetsCompleted != 3 {
		t.Errorf("Expected sets 3, got %v", log.SetsCompleted)
	}
	if log.RepsCompleted == nil || *log.RepsCompleted != 10 {
		t.Errorf("Expected reps 10, got %v", log.RepsCompleted)
	}
	if log.WeightKg == nil || math.Abs(*log.WeightKg-50.0) > 0.01 {
		t.Errorf("Expected weight 50.0, got %v", log.WeightKg)
	}
	if log.Notes != "test notes" {
		t.Errorf("Expected notes 'test notes', got %q", log.Notes)
	}
}

func TestPropagateExerciseToSchedule(t *testing.T) {
	t.Run("propagates for pending session", func(t *testing.T) {
		db := setupTestDB(t)

		userID := int64(123456)
		group, _ := db.CreateWorkoutGroup("Group", "", false, userID, "[]", "10:00", 15)
		variant, _ := db.CreateWorkoutVariant(group.ID, "Day A", nil, "")
		ex, _ := db.AddExerciseToVariant(variant.ID, "Bench Press", 3, 8, nil, nil, 0)
		session, _ := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "10:00")
		// session starts as "pending"

		newSets := 4
		newReps := 12
		newWeight := 80.0
		err := db.PropagateExerciseToSchedule(session.ID, ex.ID, "Bench Press", &newSets, &newReps, &newWeight)
		if err != nil {
			t.Fatalf("PropagateExerciseToSchedule failed: %v", err)
		}

		updated, err := db.GetWorkoutExercise(ex.ID)
		if err != nil {
			t.Fatalf("GetWorkoutExercise: %v", err)
		}
		if updated.TargetSets != 4 {
			t.Errorf("Expected target_sets 4, got %d", updated.TargetSets)
		}
		if updated.TargetRepsMin != 12 {
			t.Errorf("Expected target_reps_min 12, got %d", updated.TargetRepsMin)
		}
		if updated.TargetWeightKg == nil || math.Abs(*updated.TargetWeightKg-80.0) > 0.01 {
			t.Errorf("Expected target_weight_kg 80.0, got %v", updated.TargetWeightKg)
		}
	})

	t.Run("propagates for in_progress session", func(t *testing.T) {
		db := setupTestDB(t)

		userID := int64(123456)
		group, _ := db.CreateWorkoutGroup("Group", "", false, userID, "[]", "10:00", 15)
		variant, _ := db.CreateWorkoutVariant(group.ID, "Day A", nil, "")
		ex, _ := db.AddExerciseToVariant(variant.ID, "Squat", 3, 5, nil, nil, 0)
		session, _ := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "10:00")
		_ = db.UpdateSessionStatus(session.ID, "in_progress")

		newWeight := 100.0
		err := db.PropagateExerciseToSchedule(session.ID, ex.ID, "Squat", nil, nil, &newWeight)
		if err != nil {
			t.Fatalf("PropagateExerciseToSchedule failed: %v", err)
		}

		updated, err := db.GetWorkoutExercise(ex.ID)
		if err != nil {
			t.Fatalf("GetWorkoutExercise: %v", err)
		}
		// sets and reps should remain unchanged
		if updated.TargetSets != 3 {
			t.Errorf("Expected target_sets 3 (unchanged), got %d", updated.TargetSets)
		}
		if updated.TargetRepsMin != 5 {
			t.Errorf("Expected target_reps_min 5 (unchanged), got %d", updated.TargetRepsMin)
		}
		if updated.TargetWeightKg == nil || math.Abs(*updated.TargetWeightKg-100.0) > 0.01 {
			t.Errorf("Expected target_weight_kg 100.0, got %v", updated.TargetWeightKg)
		}
	})

	t.Run("no propagation for completed session", func(t *testing.T) {
		db := setupTestDB(t)

		userID := int64(123456)
		group, _ := db.CreateWorkoutGroup("Group", "", false, userID, "[]", "10:00", 15)
		variant, _ := db.CreateWorkoutVariant(group.ID, "Day A", nil, "")
		origWeight := 60.0
		ex, _ := db.AddExerciseToVariant(variant.ID, "Deadlift", 3, 5, nil, &origWeight, 0)
		session, _ := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "10:00")
		_ = db.UpdateSessionStatus(session.ID, "completed")

		newWeight := 120.0
		err := db.PropagateExerciseToSchedule(session.ID, ex.ID, "Deadlift", nil, nil, &newWeight)
		if err != nil {
			t.Fatalf("PropagateExerciseToSchedule failed: %v", err)
		}

		updated, err := db.GetWorkoutExercise(ex.ID)
		if err != nil {
			t.Fatalf("GetWorkoutExercise: %v", err)
		}
		if updated.TargetWeightKg == nil || math.Abs(*updated.TargetWeightKg-60.0) > 0.01 {
			t.Errorf("Expected target_weight_kg 60.0 (unchanged), got %v", updated.TargetWeightKg)
		}
	})

	t.Run("no propagation when exercise not in session variant", func(t *testing.T) {
		db := setupTestDB(t)

		userID := int64(123456)
		group, _ := db.CreateWorkoutGroup("Group", "", false, userID, "[]", "10:00", 15)
		variantA, _ := db.CreateWorkoutVariant(group.ID, "Day A", nil, "")
		variantB, _ := db.CreateWorkoutVariant(group.ID, "Day B", nil, "")
		exA, _ := db.AddExerciseToVariant(variantA.ID, "Bench Press", 3, 8, nil, nil, 0)
		// Session is for variant B, but we try to propagate exercise from variant A
		session, _ := db.CreateWorkoutSession(group.ID, variantB.ID, userID, time.Now(), "10:00")

		newSets := 5
		err := db.PropagateExerciseToSchedule(session.ID, exA.ID, "Bench Press", &newSets, nil, nil)
		if err != nil {
			t.Fatalf("PropagateExerciseToSchedule failed: %v", err)
		}

		updated, _ := db.GetWorkoutExercise(exA.ID)
		if updated.TargetSets != 3 {
			t.Errorf("Expected target_sets 3 (unchanged), got %d", updated.TargetSets)
		}
	})

	t.Run("no propagation for ad-hoc session", func(t *testing.T) {
		db := setupTestDB(t)

		userID := int64(123456)
		group, _ := db.CreateWorkoutGroup("Group", "", false, userID, "[]", "10:00", 15)
		variant, _ := db.CreateWorkoutVariant(group.ID, "Day A", nil, "")
		origWeight := 40.0
		ex, _ := db.AddExerciseToVariant(variant.ID, "OHP", 3, 8, nil, &origWeight, 0)

		// Ad-hoc session with variant_id=-1
		session, _ := db.CreateWorkoutSession(-1, -1, userID, time.Now(), "10:00")

		newWeight := 50.0
		err := db.PropagateExerciseToSchedule(session.ID, ex.ID, "OHP", nil, nil, &newWeight)
		if err != nil {
			t.Fatalf("PropagateExerciseToSchedule failed: %v", err)
		}

		updated, err := db.GetWorkoutExercise(ex.ID)
		if err != nil {
			t.Fatalf("GetWorkoutExercise: %v", err)
		}
		if updated.TargetWeightKg == nil || math.Abs(*updated.TargetWeightKg-40.0) > 0.01 {
			t.Errorf("Expected target_weight_kg 40.0 (unchanged), got %v", updated.TargetWeightKg)
		}
	})

	t.Run("propagates for notified session", func(t *testing.T) {
		db := setupTestDB(t)

		userID := int64(123456)
		group, err := db.CreateWorkoutGroup("Group", "", false, userID, "[]", "10:00", 15)
		if err != nil {
			t.Fatalf("CreateWorkoutGroup: %v", err)
		}
		variant, err := db.CreateWorkoutVariant(group.ID, "Day A", nil, "")
		if err != nil {
			t.Fatalf("CreateWorkoutVariant: %v", err)
		}
		ex, err := db.AddExerciseToVariant(variant.ID, "Rows", 3, 10, nil, nil, 0)
		if err != nil {
			t.Fatalf("AddExerciseToVariant: %v", err)
		}
		session, err := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "10:00")
		if err != nil {
			t.Fatalf("CreateWorkoutSession: %v", err)
		}
		_ = db.UpdateSessionStatus(session.ID, "notified")

		newWeight := 70.0
		err = db.PropagateExerciseToSchedule(session.ID, ex.ID, "Rows", nil, nil, &newWeight)
		if err != nil {
			t.Fatalf("PropagateExerciseToSchedule failed: %v", err)
		}

		updated, err := db.GetWorkoutExercise(ex.ID)
		if err != nil {
			t.Fatalf("GetWorkoutExercise: %v", err)
		}
		if updated.TargetWeightKg == nil || math.Abs(*updated.TargetWeightKg-70.0) > 0.01 {
			t.Errorf("Expected target_weight_kg 70.0, got %v", updated.TargetWeightKg)
		}
	})

	t.Run("no propagation for skipped session", func(t *testing.T) {
		db := setupTestDB(t)

		userID := int64(123456)
		group, err := db.CreateWorkoutGroup("Group", "", false, userID, "[]", "10:00", 15)
		if err != nil {
			t.Fatalf("CreateWorkoutGroup: %v", err)
		}
		variant, err := db.CreateWorkoutVariant(group.ID, "Day A", nil, "")
		if err != nil {
			t.Fatalf("CreateWorkoutVariant: %v", err)
		}
		origWeight := 50.0
		ex, err := db.AddExerciseToVariant(variant.ID, "Pullups", 3, 8, nil, &origWeight, 0)
		if err != nil {
			t.Fatalf("AddExerciseToVariant: %v", err)
		}
		session, err := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "10:00")
		if err != nil {
			t.Fatalf("CreateWorkoutSession: %v", err)
		}
		_ = db.UpdateSessionStatus(session.ID, "skipped")

		newWeight := 60.0
		err = db.PropagateExerciseToSchedule(session.ID, ex.ID, "Pullups", nil, nil, &newWeight)
		if err != nil {
			t.Fatalf("PropagateExerciseToSchedule failed: %v", err)
		}

		updated, err := db.GetWorkoutExercise(ex.ID)
		if err != nil {
			t.Fatalf("GetWorkoutExercise: %v", err)
		}
		if updated.TargetWeightKg == nil || math.Abs(*updated.TargetWeightKg-50.0) > 0.01 {
			t.Errorf("Expected target_weight_kg 50.0 (unchanged), got %v", updated.TargetWeightKg)
		}
	})

	t.Run("no propagation when exercise ID not in variant", func(t *testing.T) {
		db := setupTestDB(t)

		userID := int64(123456)
		group, _ := db.CreateWorkoutGroup("Group", "", false, userID, "[]", "10:00", 15)
		variant, _ := db.CreateWorkoutVariant(group.ID, "Day A", nil, "")
		origWeight := 60.0
		_, _ = db.AddExerciseToVariant(variant.ID, "Bench Press", 3, 8, nil, &origWeight, 0)
		session, _ := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "10:00")

		// Propagate for an exercise ID that doesn't exist in the variant
		newWeight := 100.0
		err := db.PropagateExerciseToSchedule(session.ID, 99999, "Unknown", nil, nil, &newWeight)
		if err != nil {
			t.Fatalf("PropagateExerciseToSchedule failed: %v", err)
		}

		// Bench Press should remain unchanged
		exercises, _ := db.ListExercisesByVariant(variant.ID)
		if len(exercises) != 1 {
			t.Fatalf("Expected 1 exercise, got %d", len(exercises))
		}
		if exercises[0].TargetWeightKg == nil || math.Abs(*exercises[0].TargetWeightKg-60.0) > 0.01 {
			t.Errorf("Expected target_weight_kg 60.0 (unchanged), got %v", exercises[0].TargetWeightKg)
		}
	})

	t.Run("clears reps_max when new reps exceed range", func(t *testing.T) {
		db := setupTestDB(t)

		userID := int64(123456)
		group, _ := db.CreateWorkoutGroup("Group", "", false, userID, "[]", "10:00", 15)
		variant, _ := db.CreateWorkoutVariant(group.ID, "Day A", nil, "")
		repsMax := 10
		ex, _ := db.AddExerciseToVariant(variant.ID, "Bench Press", 3, 8, &repsMax, nil, 0)
		session, _ := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "10:00")

		// User logs 12 reps, which exceeds the 8-10 range
		newReps := 12
		err := db.PropagateExerciseToSchedule(session.ID, ex.ID, "Bench Press", nil, &newReps, nil)
		if err != nil {
			t.Fatalf("PropagateExerciseToSchedule failed: %v", err)
		}

		updated, _ := db.GetWorkoutExercise(ex.ID)
		if updated.TargetRepsMin != 12 {
			t.Errorf("Expected target_reps_min 12, got %d", updated.TargetRepsMin)
		}
		if updated.TargetRepsMax != nil {
			t.Errorf("Expected target_reps_max nil (cleared), got %d", *updated.TargetRepsMax)
		}
	})

	t.Run("preserves reps_max when new reps within range", func(t *testing.T) {
		db := setupTestDB(t)

		userID := int64(123456)
		group, _ := db.CreateWorkoutGroup("Group", "", false, userID, "[]", "10:00", 15)
		variant, _ := db.CreateWorkoutVariant(group.ID, "Day A", nil, "")
		repsMax := 10
		ex, _ := db.AddExerciseToVariant(variant.ID, "Bench Press", 3, 8, &repsMax, nil, 0)
		session, _ := db.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "10:00")

		// User logs 9 reps, which is within 8-10 range
		newReps := 9
		err := db.PropagateExerciseToSchedule(session.ID, ex.ID, "Bench Press", nil, &newReps, nil)
		if err != nil {
			t.Fatalf("PropagateExerciseToSchedule failed: %v", err)
		}

		updated, _ := db.GetWorkoutExercise(ex.ID)
		if updated.TargetRepsMin != 9 {
			t.Errorf("Expected target_reps_min 9, got %d", updated.TargetRepsMin)
		}
		if updated.TargetRepsMax == nil || *updated.TargetRepsMax != 10 {
			t.Errorf("Expected target_reps_max 10 (preserved), got %v", updated.TargetRepsMax)
		}
	})
}
