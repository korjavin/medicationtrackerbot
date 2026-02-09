package store

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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

// TestStartSession verifies that starting a session updates status and sets started_at
func TestStartSession(t *testing.T) {
	store := setupTestDB(t)
	defer store.db.Close()

	// Create test data
	group, err := store.CreateWorkoutGroup("Test Group", "", false, 1, "[1]", "09:00", 15)
	if err != nil {
		t.Fatalf("Failed to create workout group: %v", err)
	}

	variant, err := store.CreateWorkoutVariant(group.ID, "Day A", nil, "")
	if err != nil {
		t.Fatalf("Failed to create variant: %v", err)
	}

	// Create a workout session
	session, err := store.CreateWorkoutSession(group.ID, variant.ID, 1,
		mustParseTime("2026-02-09T00:00:00Z"), "09:00")
	if err != nil {
		t.Fatalf("Failed to create session: %v", err)
	}

	// Verify initial state
	if session.Status != "pending" {
		t.Errorf("Expected initial status 'pending', got '%s'", session.Status)
	}
	if session.StartedAt != nil {
		t.Errorf("Expected StartedAt to be nil initially, got %v", session.StartedAt)
	}

	// Start the session
	err = store.StartSession(session.ID)
	if err != nil {
		t.Fatalf("Failed to start session: %v", err)
	}

	// Verify session was updated
	updated, err := store.GetWorkoutSession(session.ID)
	if err != nil {
		t.Fatalf("Failed to get updated session: %v", err)
	}

	if updated.Status != "in_progress" {
		t.Errorf("Expected status 'in_progress', got '%s'", updated.Status)
	}
	if updated.StartedAt == nil {
		t.Error("Expected StartedAt to be set, got nil")
	}
}

// TestSnoozeSession verifies that snoozing a session sets snoozed_until
func TestSnoozeSession(t *testing.T) {
	store := setupTestDB(t)
	defer store.db.Close()

	// Create test data
	group, _ := store.CreateWorkoutGroup("Test Group", "", false, 1, "[1]", "09:00", 15)
	variant, _ := store.CreateWorkoutVariant(group.ID, "Day A", nil, "")
	session, _ := store.CreateWorkoutSession(group.ID, variant.ID, 1,
		mustParseTime("2026-02-09T00:00:00Z"), "09:00")

	// Snooze for 2 hours
	err := store.SnoozeSession(session.ID, 2*60*60*1000000000) // 2 hours in nanoseconds
	if err != nil {
		t.Fatalf("Failed to snooze session: %v", err)
	}

	// Verify session was updated
	updated, err := store.GetWorkoutSession(session.ID)
	if err != nil {
		t.Fatalf("Failed to get updated session: %v", err)
	}

	if updated.SnoozedUntil == nil {
		t.Error("Expected SnoozedUntil to be set, got nil")
	}
	if updated.SnoozeCount != 1 {
		t.Errorf("Expected SnoozeCount to be 1, got %d", updated.SnoozeCount)
	}

	// Snooze again
	err = store.SnoozeSession(session.ID, 1*60*60*1000000000) // 1 hour
	if err != nil {
		t.Fatalf("Failed to snooze session again: %v", err)
	}

	updated, _ = store.GetWorkoutSession(session.ID)
	if updated.SnoozeCount != 2 {
		t.Errorf("Expected SnoozeCount to be 2 after second snooze, got %d", updated.SnoozeCount)
	}
}

// TestClearSnooze verifies that clearing snooze removes snoozed_until
func TestClearSnooze(t *testing.T) {
	store := setupTestDB(t)
	defer store.db.Close()

	// Create test data
	group, _ := store.CreateWorkoutGroup("Test Group", "", false, 1, "[1]", "09:00", 15)
	variant, _ := store.CreateWorkoutVariant(group.ID, "Day A", nil, "")
	session, _ := store.CreateWorkoutSession(group.ID, variant.ID, 1,
		mustParseTime("2026-02-09T00:00:00Z"), "09:00")

	// Snooze the session
	store.SnoozeSession(session.ID, 2*60*60*1000000000)

	// Verify it's snoozed
	snoozed, _ := store.GetWorkoutSession(session.ID)
	if snoozed.SnoozedUntil == nil {
		t.Fatal("Session should be snoozed")
	}

	// Clear the snooze
	err := store.ClearSnooze(session.ID)
	if err != nil {
		t.Fatalf("Failed to clear snooze: %v", err)
	}

	// Verify snooze was cleared
	cleared, err := store.GetWorkoutSession(session.ID)
	if err != nil {
		t.Fatalf("Failed to get session after clearing snooze: %v", err)
	}

	if cleared.SnoozedUntil != nil {
		t.Errorf("Expected SnoozedUntil to be nil after clearing, got %v", cleared.SnoozedUntil)
	}
}

// TestGetSnoozedSessions verifies retrieving snoozed sessions
func TestGetSnoozedSessions(t *testing.T) {
	store := setupTestDB(t)
	defer store.db.Close()

	userID := int64(1)

	// Create test data
	group, _ := store.CreateWorkoutGroup("Test Group", "", false, userID, "[1]", "09:00", 15)
	variant, _ := store.CreateWorkoutVariant(group.ID, "Day A", nil, "")

	// Create multiple sessions
	session1, _ := store.CreateWorkoutSession(group.ID, variant.ID, userID,
		mustParseTime("2026-02-09T00:00:00Z"), "09:00")
	session2, _ := store.CreateWorkoutSession(group.ID, variant.ID, userID,
		mustParseTime("2026-02-10T00:00:00Z"), "09:00")
	session3, _ := store.CreateWorkoutSession(group.ID, variant.ID, userID,
		mustParseTime("2026-02-11T00:00:00Z"), "09:00")

	// Manually set snoozed_until in the PAST using direct SQL
	// Use UTC to match CURRENT_TIMESTAMP behavior in SQLite
	pastTime1 := time.Now().UTC().Add(-3 * time.Hour)
	pastTime2 := time.Now().UTC().Add(-2 * time.Hour)

	_, err := store.db.Exec("UPDATE workout_sessions SET snoozed_until = ? WHERE id = ?", pastTime1, session1.ID)
	if err != nil {
		t.Fatalf("Failed to set snoozed_until for session1: %v", err)
	}

	_, err = store.db.Exec("UPDATE workout_sessions SET snoozed_until = ? WHERE id = ?", pastTime2, session2.ID)
	if err != nil {
		t.Fatalf("Failed to set snoozed_until for session2: %v", err)
	}

	// Don't snooze session3

	// Get snoozed sessions
	snoozed, err := store.GetSnoozedSessions(userID)
	if err != nil {
		t.Fatalf("Failed to get snoozed sessions: %v", err)
	}

	// Should return 2 snoozed sessions
	if len(snoozed) != 2 {
		t.Errorf("Expected 2 snoozed sessions, got %d", len(snoozed))
	}

	// Verify the sessions are the right ones
	foundSession1 := false
	foundSession2 := false
	for _, s := range snoozed {
		if s.ID == session1.ID {
			foundSession1 = true
		}
		if s.ID == session2.ID {
			foundSession2 = true
		}
		if s.ID == session3.ID {
			t.Error("Session3 should not be in snoozed sessions")
		}
	}

	if !foundSession1 {
		t.Error("Session1 should be in snoozed sessions")
	}
	if !foundSession2 {
		t.Error("Session2 should be in snoozed sessions")
	}
}

// TestWorkoutStatistics verifies statistics calculation
func TestWorkoutStatistics(t *testing.T) {
	store := setupTestDB(t)
	defer store.db.Close()

	userID := int64(1)

	// Create test data
	group, _ := store.CreateWorkoutGroup("Test Group", "", false, userID, "[1,2,3]", "09:00", 15)
	variant, _ := store.CreateWorkoutVariant(group.ID, "Day A", nil, "")

	// Create sessions with different statuses
	// Session 1: completed (should count in streak and completion rate)
	session1, _ := store.CreateWorkoutSession(group.ID, variant.ID, userID,
		mustParseTime("2026-02-01T00:00:00Z"), "09:00")
	store.StartSession(session1.ID)
	store.CompleteSession(session1.ID)

	// Session 2: completed (should count in streak)
	session2, _ := store.CreateWorkoutSession(group.ID, variant.ID, userID,
		mustParseTime("2026-02-02T00:00:00Z"), "09:00")
	store.StartSession(session2.ID)
	store.CompleteSession(session2.ID)

	// Session 3: skipped (should break streak, count in total)
	session3, _ := store.CreateWorkoutSession(group.ID, variant.ID, userID,
		mustParseTime("2026-02-03T00:00:00Z"), "09:00")
	store.SkipSession(session3.ID)

	// Session 4: completed (should NOT count in streak due to skip before it)
	session4, _ := store.CreateWorkoutSession(group.ID, variant.ID, userID,
		mustParseTime("2026-02-04T00:00:00Z"), "09:00")
	store.StartSession(session4.ID)
	store.CompleteSession(session4.ID)

	// Session 5: pending (should not count in totals)
	_, _ = store.CreateWorkoutSession(group.ID, variant.ID, userID,
		mustParseTime("2026-02-05T00:00:00Z"), "09:00")

	// Get workout history to calculate stats
	sessions, err := store.GetWorkoutHistory(userID, 100)
	if err != nil {
		t.Fatalf("Failed to get workout history: %v", err)
	}

	// Calculate stats (mimicking server logic)
	totalSessions := 0
	completedSessions := 0
	skippedSessions := 0
	var streak int

	for _, session := range sessions {

		switch session.Status {
		case "completed":
			completedSessions++
			totalSessions++
		case "skipped":
			skippedSessions++
			totalSessions++
		}
	}

	// Calculate streak (sessions are in DESC order by date)
	for _, session := range sessions {
		if session.Status == "completed" {
			streak++
		} else if session.Status == "skipped" || session.Status == "pending" {
			break
		}
	}

	// Verify statistics
	if totalSessions != 4 {
		t.Errorf("Expected total_sessions to be 4, got %d", totalSessions)
	}

	if completedSessions != 3 {
		t.Errorf("Expected completed_sessions to be 3, got %d", completedSessions)
	}

	if skippedSessions != 1 {
		t.Errorf("Expected skipped_sessions to be 1, got %d", skippedSessions)
	}

	// Streak calculation: sessions are ordered DESC by scheduled_date (newest first)
	// Session 5 (pending) -> break immediately, streak = 0
	// Expected: 0 (no current streak because most recent session is pending)
	expectedStreak := 0
	if streak != expectedStreak {
		t.Errorf("Expected current_streak to be %d, got %d", expectedStreak, streak)
		t.Logf("Sessions order:")
		for i, s := range sessions {
			t.Logf("  %d: ID=%d, Date=%v, Status=%s", i, s.ID, s.ScheduledDate, s.Status)
		}
	}

	// Test completion rate calculation
	completionRate := float64(completedSessions) / float64(totalSessions) * 100
	expectedRate := 75.0 // 3/4 = 75%
	if completionRate != expectedRate {
		t.Errorf("Expected completion_rate to be %.1f%%, got %.1f%%", expectedRate, completionRate)
	}
}

// Helper function to parse time strings for tests
func mustParseTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}
