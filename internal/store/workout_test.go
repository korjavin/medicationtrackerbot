package store

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

// setupTestDB creates an in-memory test database with the workout schema from migrations
func setupTestDB(t *testing.T) *Store {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("Failed to open test database: %v", err)
	}

	// Read the workout migration file
	migrationPath := filepath.Join("migrations", "012_add_workout_tracking.sql")
	schemaBytes, err := os.ReadFile(migrationPath)
	if err != nil {
		t.Fatalf("Failed to read migration file: %v", err)
	}

	// Extract only the SQL between "-- +goose Up" and "-- +goose Down"
	schemaSQL := string(schemaBytes)
	upStart := strings.Index(schemaSQL, "-- +goose Up")
	downStart := strings.Index(schemaSQL, "-- +goose Down")

	if upStart == -1 || downStart == -1 {
		t.Fatalf("Migration file doesn't contain goose directives")
	}

	// Get SQL between directives, skipping the "-- +goose Up" line itself
	upSQL := schemaSQL[upStart:downStart]
	upSQL = strings.TrimPrefix(upSQL, "-- +goose Up")
	upSQL = strings.TrimSpace(upSQL)

	// Execute the migration
	if _, err := db.Exec(upSQL); err != nil {
		t.Fatalf("Failed to execute migration: %v", err)
	}

	return &Store{db: db}
}

// TestUpdateWorkoutExercise_OrderIndex verifies that updating an exercise correctly updates the order_index
func TestUpdateWorkoutExercise_OrderIndex(t *testing.T) {
	store := setupTestDB(t)
	defer store.db.Close()

	// Create test data
	group, err := store.CreateWorkoutGroup("Test Group", "Test Description", false, 1, "[1,2,3]", "09:00", 15)
	if err != nil {
		t.Fatalf("Failed to create workout group: %v", err)
	}

	variant, err := store.CreateWorkoutVariant(group.ID, "Day A", nil, "Test variant")
	if err != nil {
		t.Fatalf("Failed to create variant: %v", err)
	}

	// Create an exercise with order_index = 0
	weight := 40.0
	repsMax := 10
	exercise, err := store.AddExerciseToVariant(variant.ID, "Barbell Rows", 4, 8, &repsMax, &weight, 0)
	if err != nil {
		t.Fatalf("Failed to create exercise: %v", err)
	}

	// Verify initial order_index
	if exercise.OrderIndex != 0 {
		t.Fatalf("Expected initial order_index to be 0, got %d", exercise.OrderIndex)
	}

	// Test: Update the exercise with a new order_index = 5
	newOrderIndex := 5
	err = store.UpdateWorkoutExercise(exercise.ID, "Barbell Rows", 4, 8, &repsMax, &weight, newOrderIndex)
	if err != nil {
		t.Fatalf("Failed to update exercise: %v", err)
	}

	// Verify: Fetch the exercise and check that order_index was updated
	updatedExercise, err := store.GetWorkoutExercise(exercise.ID)
	if err != nil {
		t.Fatalf("Failed to get updated exercise: %v", err)
	}

	if updatedExercise.OrderIndex != newOrderIndex {
		t.Errorf("Expected order_index to be %d after update, got %d", newOrderIndex, updatedExercise.OrderIndex)
	}

	// Also verify other fields were updated correctly
	if updatedExercise.ExerciseName != "Barbell Rows" {
		t.Errorf("Expected exercise_name to be 'Barbell Rows', got '%s'", updatedExercise.ExerciseName)
	}
	if updatedExercise.TargetSets != 4 {
		t.Errorf("Expected target_sets to be 4, got %d", updatedExercise.TargetSets)
	}
}

// TestUpdateWorkoutExercise_OrderIndexChange verifies changing order affects exercise ordering
func TestUpdateWorkoutExercise_OrderIndexChange(t *testing.T) {
	store := setupTestDB(t)
	defer store.db.Close()

	// Create test data
	group, err := store.CreateWorkoutGroup("Test Group", "Test Description", false, 1, "[1,2,3]", "09:00", 15)
	if err != nil {
		t.Fatalf("Failed to create workout group: %v", err)
	}

	variant, err := store.CreateWorkoutVariant(group.ID, "Day A", nil, "Test variant")
	if err != nil {
		t.Fatalf("Failed to create variant: %v", err)
	}

	// Create three exercises with different order indices
	weight := 40.0
	repsMax := 10
	ex1, err := store.AddExerciseToVariant(variant.ID, "Exercise 1", 4, 8, &repsMax, &weight, 0)
	if err != nil {
		t.Fatalf("Failed to create exercise 1: %v", err)
	}

	ex2, err := store.AddExerciseToVariant(variant.ID, "Exercise 2", 4, 8, &repsMax, &weight, 1)
	if err != nil {
		t.Fatalf("Failed to create exercise 2: %v", err)
	}

	ex3, err := store.AddExerciseToVariant(variant.ID, "Exercise 3", 4, 8, &repsMax, &weight, 2)
	if err != nil {
		t.Fatalf("Failed to create exercise 3: %v", err)
	}

	// Test: Change ex1's order from 0 to 2 (move it to the end)
	err = store.UpdateWorkoutExercise(ex1.ID, "Exercise 1", 4, 8, &repsMax, &weight, 2)
	if err != nil {
		t.Fatalf("Failed to update exercise order: %v", err)
	}

	// Verify: List exercises and check they're ordered correctly
	exercises, err := store.ListExercisesByVariant(variant.ID)
	if err != nil {
		t.Fatalf("Failed to list exercises: %v", err)
	}

	if len(exercises) != 3 {
		t.Fatalf("Expected 3 exercises, got %d", len(exercises))
	}

	// Exercises should be sorted by order_index: ex2(1), ex3(2), ex1(2)
	// Note: ex1 and ex3 both have order_index=2, so their relative order depends on other factors
	// But ex2 should definitely come first
	if exercises[0].ID != ex2.ID {
		t.Errorf("Expected first exercise to be ex2 (order_index=1), got ex%d", exercises[0].ID-ex1.ID+1)
	}

	// Verify ex1 has the new order_index
	updatedEx1, err := store.GetWorkoutExercise(ex1.ID)
	if err != nil {
		t.Fatalf("Failed to get updated exercise 1: %v", err)
	}
	if updatedEx1.OrderIndex != 2 {
		t.Errorf("Expected ex1 order_index to be 2, got %d", updatedEx1.OrderIndex)
	}

	// Verify ex3 still has its original order_index
	updatedEx3, err := store.GetWorkoutExercise(ex3.ID)
	if err != nil {
		t.Fatalf("Failed to get exercise 3: %v", err)
	}
	if updatedEx3.OrderIndex != 2 {
		t.Errorf("Expected ex3 order_index to be 2, got %d", updatedEx3.OrderIndex)
	}
}
