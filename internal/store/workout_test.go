package store

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

// setupTestDB creates an in-memory test database with the workout schema from migrations
func applyMigration(t *testing.T, db *sql.DB, migrationFile string) {
	schemaBytes, err := os.ReadFile(migrationFile) // #nosec G304
	if err != nil {
		t.Fatalf("Failed to read migration file %s: %v", migrationFile, err)
	}

	schemaSQL := string(schemaBytes)
	upStart := strings.Index(schemaSQL, "-- +goose Up")
	downStart := strings.Index(schemaSQL, "-- +goose Down")

	if upStart == -1 || downStart == -1 {
		t.Fatalf("Migration file %s doesn't contain goose directives", migrationFile)
	}

	upSQL := schemaSQL[upStart:downStart]
	upSQL = strings.TrimPrefix(upSQL, "-- +goose Up")
	upSQL = strings.TrimSpace(upSQL)

	if _, err := db.Exec(upSQL); err != nil {
		t.Fatalf("Failed to execute migration %s: %v", migrationFile, err)
	}
}

func setupTestDB(t *testing.T) *Store {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("Failed to open test database: %v", err)
	}

	// Apply workout migration
	applyMigration(t, db, filepath.Join("migrations", "012_add_workout_tracking.sql"))

	// Create change_events table (needed by exercise_library triggers)
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS change_events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		tag TEXT NOT NULL,
		created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
	)`); err != nil {
		t.Fatalf("Failed to create change_events table: %v", err)
	}

	// Apply exercise library migration
	applyMigration(t, db, filepath.Join("migrations", "028_add_exercise_library.sql"))

	// Apply exercise log source tracking migration
	applyMigration(t, db, filepath.Join("migrations", "052_add_exercise_log_source.sql"))

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
	store.SnoozeSession(session.ID, 2*60*60*1000000000) //nolint:errcheck // test setup

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
	store.StartSession(session1.ID)    //nolint:errcheck // test setup
	store.CompleteSession(session1.ID) //nolint:errcheck // test setup

	// Session 2: completed (should count in streak)
	session2, _ := store.CreateWorkoutSession(group.ID, variant.ID, userID,
		mustParseTime("2026-02-02T00:00:00Z"), "09:00")
	store.StartSession(session2.ID)    //nolint:errcheck // test setup
	store.CompleteSession(session2.ID) //nolint:errcheck // test setup

	// Session 3: skipped (should break streak, count in total)
	session3, _ := store.CreateWorkoutSession(group.ID, variant.ID, userID,
		mustParseTime("2026-02-03T00:00:00Z"), "09:00")
	store.SkipSession(session3.ID) //nolint:errcheck // test setup

	// Session 4: completed (should NOT count in streak due to skip before it)
	session4, _ := store.CreateWorkoutSession(group.ID, variant.ID, userID,
		mustParseTime("2026-02-04T00:00:00Z"), "09:00")
	store.StartSession(session4.ID)    //nolint:errcheck // test setup
	store.CompleteSession(session4.ID) //nolint:errcheck // test setup

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

// TestGetAllUniqueExercises verifies that unique exercises are retrieved across all active workouts
func TestGetAllUniqueExercises(t *testing.T) {
	store := setupTestDB(t)
	defer store.db.Close()

	userID := int64(1)

	// Create test data: 2 groups, each with variants
	group1, err := store.CreateWorkoutGroup("Morning Swings", "", false, userID, "[1,2,3]", "09:00", 15)
	if err != nil {
		t.Fatalf("Failed to create group1: %v", err)
	}

	group2, err := store.CreateWorkoutGroup("Evening Main", "", true, userID, "[1,3,5]", "18:00", 15)
	if err != nil {
		t.Fatalf("Failed to create group2: %v", err)
	}

	variant1, err := store.CreateWorkoutVariant(group1.ID, "Default", nil, "")
	if err != nil {
		t.Fatalf("Failed to create variant1: %v", err)
	}

	zero := 0
	variant2, err := store.CreateWorkoutVariant(group2.ID, "Day A", &zero, "")
	if err != nil {
		t.Fatalf("Failed to create variant2: %v", err)
	}

	variant3, err := store.CreateWorkoutVariant(group2.ID, "Day B", &zero, "")
	if err != nil {
		t.Fatalf("Failed to create variant3: %v", err)
	}

	// Add exercises to variants
	weight30 := 30.0
	weight40 := 40.0
	repsMax15 := 15
	repsMax20 := 20
	repsMax10 := 10

	// Variant 1: Kettlebell Swings
	_, err = store.AddExerciseToVariant(variant1.ID, "Kettlebell Swings", 3, 15, &repsMax20, &weight30, 0)
	if err != nil {
		t.Fatalf("Failed to create exercise: %v", err)
	}

	// Variant 2 (Day A): Barbell Rows
	_, err = store.AddExerciseToVariant(variant2.ID, "Barbell Rows", 4, 8, &repsMax10, &weight40, 0)
	if err != nil {
		t.Fatalf("Failed to create exercise: %v", err)
	}

	// Variant 3 (Day B): Bench Press + Kettlebell Swings (duplicate)
	_, err = store.AddExerciseToVariant(variant3.ID, "Bench Press", 4, 8, &repsMax10, &weight40, 0)
	if err != nil {
		t.Fatalf("Failed to create exercise: %v", err)
	}
	_, err = store.AddExerciseToVariant(variant3.ID, "Kettlebell Swings", 2, 10, &repsMax15, &weight30, 1)
	if err != nil {
		t.Fatalf("Failed to create duplicate exercise: %v", err)
	}

	// Test 1: Get all unique exercises
	exercises, err := store.GetAllUniqueExercises(userID)
	if err != nil {
		t.Fatalf("Failed to get unique exercises: %v", err)
	}

	// Should return 3 unique exercises (Kettlebell Swings deduplicated)
	if len(exercises) != 3 {
		t.Errorf("Expected 3 unique exercises, got %d", len(exercises))
	}

	// Verify exercise names are unique
	exerciseNames := make(map[string]bool)
	for _, ex := range exercises {
		if exerciseNames[ex.ExerciseName] {
			t.Errorf("Duplicate exercise name found: %s", ex.ExerciseName)
		}
		exerciseNames[ex.ExerciseName] = true
	}

	// Verify expected exercises are present
	expectedNames := map[string]bool{
		"Kettlebell Swings": false,
		"Barbell Rows":      false,
		"Bench Press":       false,
	}

	for _, ex := range exercises {
		if _, exists := expectedNames[ex.ExerciseName]; exists {
			expectedNames[ex.ExerciseName] = true
		} else {
			t.Errorf("Unexpected exercise: %s", ex.ExerciseName)
		}
	}

	for name, found := range expectedNames {
		if !found {
			t.Errorf("Expected exercise not found: %s", name)
		}
	}

	// Test 2: Verify filtering by active groups
	// Deactivate group1
	err = store.UpdateWorkoutGroup(group1.ID, "Morning Swings", "", false, "[1,2,3]", "09:00", 15, false)
	if err != nil {
		t.Fatalf("Failed to deactivate group1: %v", err)
	}

	// Get unique exercises again
	activeExercises, err := store.GetAllUniqueExercises(userID)
	if err != nil {
		t.Fatalf("Failed to get unique exercises after deactivation: %v", err)
	}

	// Should only return exercises from active group2: Barbell Rows, Bench Press, Kettlebell Swings
	// (Kettlebell Swings is still present in variant3)
	if len(activeExercises) != 3 {
		t.Errorf("Expected 3 exercises from active groups, got %d", len(activeExercises))
	}

	// Verify Kettlebell Swings is still present (from variant3)
	foundKettlebell := false
	for _, ex := range activeExercises {
		if ex.ExerciseName == "Kettlebell Swings" {
			foundKettlebell = true
			break
		}
	}
	if !foundKettlebell {
		t.Error("Kettlebell Swings from variant3 should still be present")
	}

	// Test 3: Verify empty list when no exercises exist
	userID2 := int64(2)
	emptyExercises, err := store.GetAllUniqueExercises(userID2)
	if err != nil {
		t.Fatalf("Failed to get unique exercises for user2: %v", err)
	}

	if len(emptyExercises) != 0 {
		t.Errorf("Expected 0 exercises for user2, got %d", len(emptyExercises))
	}
}

// TestGetActiveSessions verifies retrieving active (notified/in_progress) sessions for a specific date
func TestGetActiveSessions(t *testing.T) {
	store := setupTestDB(t)
	defer store.db.Close()

	userID := int64(1)

	// Create a workout group
	group, err := store.CreateWorkoutGroup("Morning Swings", "Kettlebell", false, userID, "[1,3,5]", "09:00", 15)
	if err != nil {
		t.Fatalf("Failed to create workout group: %v", err)
	}

	// Create a variant
	variant, err := store.CreateWorkoutVariant(group.ID, "Default", nil, "")
	if err != nil {
		t.Fatalf("Failed to create variant: %v", err)
	}

	today := time.Now()
	yesterday := today.AddDate(0, 0, -1)

	// Create sessions with different statuses
	sessionNotified, _ := store.CreateWorkoutSession(group.ID, variant.ID, userID, today, "09:00")
	store.UpdateSessionStatus(sessionNotified.ID, "notified") //nolint:errcheck // test setup

	sessionInProgress, _ := store.CreateWorkoutSession(group.ID, variant.ID, userID, today, "10:00")
	store.StartSession(sessionInProgress.ID) //nolint:errcheck // test setup

	// Create a pending session (not included in active sessions)
	_, _ = store.CreateWorkoutSession(group.ID, variant.ID, userID, today, "11:00")

	sessionCompleted, _ := store.CreateWorkoutSession(group.ID, variant.ID, userID, today, "14:00")
	store.CompleteSession(sessionCompleted.ID) //nolint:errcheck // test setup

	sessionYesterday, _ := store.CreateWorkoutSession(group.ID, variant.ID, userID, yesterday, "09:00")
	store.UpdateSessionStatus(sessionYesterday.ID, "notified") //nolint:errcheck // test setup

	// Get active sessions for today
	activeSessions, err := store.GetActiveSessions(userID, today)
	if err != nil {
		t.Fatalf("Failed to get active sessions: %v", err)
	}

	// Should return only the notified and in_progress sessions from today
	if len(activeSessions) != 2 {
		t.Errorf("Expected 2 active sessions, got %d", len(activeSessions))
	}

	// Verify they are ordered by scheduled_time
	if len(activeSessions) == 2 {
		if activeSessions[0].ScheduledTime != "09:00" {
			t.Errorf("Expected first session at 09:00, got %s", activeSessions[0].ScheduledTime)
		}
		if activeSessions[1].ScheduledTime != "10:00" {
			t.Errorf("Expected second session at 10:00, got %s", activeSessions[1].ScheduledTime)
		}

		// Verify statuses
		if activeSessions[0].Status != "notified" {
			t.Errorf("Expected first session status 'notified', got %s", activeSessions[0].Status)
		}
		if activeSessions[1].Status != "in_progress" {
			t.Errorf("Expected second session status 'in_progress', got %s", activeSessions[1].Status)
		}
	}
}

// TestInitializeAndAdvanceRotation verifies workout rotation logic
func TestInitializeAndAdvanceRotation(t *testing.T) {
	store := setupTestDB(t)
	defer store.db.Close()

	userID := int64(1)
	group, _ := store.CreateWorkoutGroup("Rotating Group", "", true, userID, "[1]", "09:00", 15)

	variant1, _ := store.CreateWorkoutVariant(group.ID, "Variant 1", intPtr(1), "")
	variant2, _ := store.CreateWorkoutVariant(group.ID, "Variant 2", intPtr(2), "")

	// Initialize rotation
	err := store.InitializeRotation(group.ID, variant1.ID)
	if err != nil {
		t.Fatalf("Failed to initialize rotation: %v", err)
	}

	state, _ := store.GetRotationState(group.ID)
	if state.CurrentVariantID != variant1.ID {
		t.Errorf("Expected current variant %d, got %d", variant1.ID, state.CurrentVariantID)
	}

	// Advance rotation
	err = store.AdvanceRotation(group.ID)
	if err != nil {
		t.Fatalf("Failed to advance rotation: %v", err)
	}

	state, _ = store.GetRotationState(group.ID)
	if state.CurrentVariantID != variant2.ID {
		t.Errorf("Expected current variant %d, got %d", variant2.ID, state.CurrentVariantID)
	}

	// Advance again (circular)
	store.AdvanceRotation(group.ID)
	state, _ = store.GetRotationState(group.ID)
	if state.CurrentVariantID != variant1.ID {
		t.Errorf("Expected current variant %d (circular), got %d", variant1.ID, state.CurrentVariantID)
	}
}

// TestListWorkoutGroups verifies listing groups for a user
func TestListWorkoutGroups(t *testing.T) {
	store := setupTestDB(t)
	defer store.db.Close()

	userID := int64(1)
	store.CreateWorkoutGroup("Group 1", "", false, userID, "[1]", "09:00", 15)
	store.CreateWorkoutGroup("Group 2", "", false, userID, "[1]", "10:00", 15)
	store.CreateWorkoutGroup("Group 3", "", false, int64(999), "[1]", "11:00", 15)

	groups, err := store.ListWorkoutGroups(userID, false)
	if err != nil {
		t.Fatalf("Failed to list groups: %v", err)
	}

	if len(groups) != 2 {
		t.Errorf("Expected 2 groups for user %d, got %d", userID, len(groups))
	}
}

// TestUpdateWorkoutVariant verifies updating a variant
func TestUpdateWorkoutVariant(t *testing.T) {
	store := setupTestDB(t)
	defer store.db.Close()

	group, _ := store.CreateWorkoutGroup("G", "", false, 1, "[1]", "09:00", 15)
	variant, _ := store.CreateWorkoutVariant(group.ID, "Old Name", intPtr(1), "Old Desc")

	err := store.UpdateWorkoutVariant(variant.ID, "New Name", intPtr(2), "New Desc")
	if err != nil {
		t.Fatalf("Failed to update variant: %v", err)
	}

	updated, _ := store.GetWorkoutVariant(variant.ID)
	if updated.Name != "New Name" || *updated.RotationOrder != 2 || updated.Description != "New Desc" {
		t.Errorf("Variant not updated correctly: %+v", updated)
	}
}

func intPtr(i int) *int { return &i }

// TestListRecentExerciseLogsByName verifies the resolver helper returns matching
// logs for a user, ordered newest-first, and ignores logs from other users.
func TestListRecentExerciseLogsByName(t *testing.T) {
	st := setupTestDB(t)
	defer st.db.Close()

	userA := int64(1)
	userB := int64(2)

	// Build a small history under user A: two logs for "Biceps Curls" on
	// successive days, plus one for "Squat".
	groupA, _ := st.CreateWorkoutGroup("A", "", false, userA, "[1]", "09:00", 15)
	variantA, _ := st.CreateWorkoutVariant(groupA.ID, "Day A", nil, "")

	dayOlder, _ := time.Parse("2006-01-02", "2026-04-01")
	dayNewer, _ := time.Parse("2006-01-02", "2026-04-15")

	sessOld, _ := st.CreateWorkoutSession(groupA.ID, variantA.ID, userA, dayOlder, "09:00")
	sessNew, _ := st.CreateWorkoutSession(groupA.ID, variantA.ID, userA, dayNewer, "09:00")

	sets, reps := 3, 10
	w := 10.0
	if _, err := st.LogExerciseWithSource(sessOld.ID, 0, "Biceps Curls", &sets, &reps, &w, "completed", "", "library"); err != nil {
		t.Fatalf("seed log: %v", err)
	}
	sets2, reps2 := 4, 8
	w2 := 12.5
	if _, err := st.LogExerciseWithSource(sessNew.ID, 0, "biceps curls", &sets2, &reps2, &w2, "completed", "", "library"); err != nil {
		t.Fatalf("seed log: %v", err)
	}
	if _, err := st.LogExerciseWithSource(sessNew.ID, 0, "Squat", &sets, &reps, &w, "completed", "", "library"); err != nil {
		t.Fatalf("seed log: %v", err)
	}

	// User B logs the same exercise — should NOT appear in user A's results.
	groupB, _ := st.CreateWorkoutGroup("B", "", false, userB, "[1]", "09:00", 15)
	variantB, _ := st.CreateWorkoutVariant(groupB.ID, "Day B", nil, "")
	sessB, _ := st.CreateWorkoutSession(groupB.ID, variantB.ID, userB, dayNewer, "09:00")
	if _, err := st.LogExerciseWithSource(sessB.ID, 0, "Biceps Curls", &sets, &reps, &w, "completed", "", "library"); err != nil {
		t.Fatalf("seed user B log: %v", err)
	}

	logs, err := st.ListRecentExerciseLogsByName(context.Background(), userA, "biceps curls", 5)
	if err != nil {
		t.Fatalf("ListRecentExerciseLogsByName: %v", err)
	}
	if len(logs) != 2 {
		t.Fatalf("expected 2 logs, got %d", len(logs))
	}
	// Newest-first: the most recent log should be first.
	if logs[0].SessionID != sessNew.ID {
		t.Errorf("expected newest session %d first, got %d", sessNew.ID, logs[0].SessionID)
	}
	if *logs[0].WeightKg != 12.5 {
		t.Errorf("newest log weight = %v, want 12.5", *logs[0].WeightKg)
	}

	// limit = 1 should truncate.
	logs1, _ := st.ListRecentExerciseLogsByName(context.Background(), userA, "biceps curls", 1)
	if len(logs1) != 1 {
		t.Errorf("limit=1 returned %d logs", len(logs1))
	}
}

// TestGetDistinctExerciseNamesForUser verifies the resolver catalog helper
// merges exercise_library and historical workout_exercise_logs for the user.
func TestGetDistinctExerciseNamesForUser(t *testing.T) {
	st := setupTestDB(t)
	defer st.db.Close()

	userA := int64(1)
	userB := int64(2)

	// User A has a library entry plus a historical log of a different exercise.
	if _, err := st.CreateExerciseLibraryItem(userA, "Bench Press", 3, 8, nil, nil, ""); err != nil {
		t.Fatalf("seed library: %v", err)
	}
	groupA, _ := st.CreateWorkoutGroup("A", "", false, userA, "[1]", "09:00", 15)
	variantA, _ := st.CreateWorkoutVariant(groupA.ID, "Day A", nil, "")
	day, _ := time.Parse("2006-01-02", "2026-04-15")
	sessA, _ := st.CreateWorkoutSession(groupA.ID, variantA.ID, userA, day, "09:00")
	sets, reps := 3, 10
	w := 10.0
	if _, err := st.LogExerciseWithSource(sessA.ID, 0, "Squat", &sets, &reps, &w, "completed", "", "library"); err != nil {
		t.Fatalf("seed log: %v", err)
	}
	// Same name in library and history → still a single entry after dedup.
	if _, err := st.LogExerciseWithSource(sessA.ID, 0, "Bench Press", &sets, &reps, &w, "completed", "", "library"); err != nil {
		t.Fatalf("seed log: %v", err)
	}

	// User B has their own library entry — should not leak to A.
	if _, err := st.CreateExerciseLibraryItem(userB, "Deadlift", 1, 5, nil, nil, ""); err != nil {
		t.Fatalf("seed library B: %v", err)
	}

	names, err := st.GetDistinctExerciseNamesForUser(context.Background(), userA)
	if err != nil {
		t.Fatalf("GetDistinctExerciseNamesForUser: %v", err)
	}
	want := map[string]bool{"Bench Press": true, "Squat": true}
	if len(names) != len(want) {
		t.Fatalf("got %v, want %v", names, want)
	}
	for _, n := range names {
		if !want[n] {
			t.Errorf("unexpected name %q (or user B leaked)", n)
		}
	}
}

// TestUpsertExerciseLogByName verifies the (session_id, exercise_name)
// idempotency helper used by the MCP workout_log endpoint: first call
// inserts, subsequent call with same name (case-insensitive) updates.
func TestUpsertExerciseLogByName(t *testing.T) {
	st := setupTestDB(t)
	defer st.db.Close()

	userA := int64(1)
	groupA, _ := st.CreateWorkoutGroup("A", "", false, userA, "[1]", "09:00", 15)
	variantA, _ := st.CreateWorkoutVariant(groupA.ID, "Day A", nil, "")
	day, _ := time.Parse("2006-01-02", "2026-04-15")
	sess, _ := st.CreateWorkoutSession(groupA.ID, variantA.ID, userA, day, "09:00")

	ctx := context.Background()
	sets, reps := 3, 10
	w := 10.0

	id1, isNew1, err := st.UpsertExerciseLogByName(ctx, sess.ID, 0, "Biceps Curls", &sets, &reps, &w, "completed", "", "agent", time.Time{})
	if err != nil {
		t.Fatalf("first upsert: %v", err)
	}
	if !isNew1 {
		t.Errorf("first upsert should be new, got isNew=false")
	}

	// Re-send with different name casing should update, not insert.
	sets2, reps2 := 4, 8
	w2 := 12.5
	id2, isNew2, err := st.UpsertExerciseLogByName(ctx, sess.ID, 0, "biceps curls", &sets2, &reps2, &w2, "completed", "agent re-send", "agent", time.Time{})
	if err != nil {
		t.Fatalf("second upsert: %v", err)
	}
	if isNew2 {
		t.Errorf("re-send should update, got isNew=true")
	}
	if id2 != id1 {
		t.Errorf("expected same id, got %d vs %d", id2, id1)
	}

	logs, err := st.GetExerciseLogs(sess.ID)
	if err != nil {
		t.Fatalf("GetExerciseLogs: %v", err)
	}
	if len(logs) != 1 {
		t.Fatalf("expected 1 log after upsert, got %d", len(logs))
	}
	if logs[0].SetsCompleted == nil || *logs[0].SetsCompleted != 4 {
		t.Errorf("sets not updated, got %+v", logs[0].SetsCompleted)
	}
	if logs[0].WeightKg == nil || *logs[0].WeightKg != 12.5 {
		t.Errorf("weight not updated, got %+v", logs[0].WeightKg)
	}
	if logs[0].Notes != "agent re-send" {
		t.Errorf("notes not updated, got %q", logs[0].Notes)
	}

	// A different exercise name → new row.
	id3, isNew3, err := st.UpsertExerciseLogByName(ctx, sess.ID, 0, "Squat", &sets, &reps, &w, "completed", "", "agent", time.Time{})
	if err != nil {
		t.Fatalf("third upsert: %v", err)
	}
	if !isNew3 {
		t.Errorf("different name should be new, got isNew=false")
	}
	if id3 == id1 {
		t.Errorf("different name should have different id")
	}

	logs2, _ := st.GetExerciseLogs(sess.ID)
	if len(logs2) != 2 {
		t.Errorf("expected 2 logs after second exercise, got %d", len(logs2))
	}
}

// TestCreatePlannedAdHocSession verifies a future ad-hoc session is created
// in 'pending' state with no started_at and the expected sentinel IDs.
func TestCreatePlannedAdHocSession(t *testing.T) {
	st := setupTestDB(t)
	defer st.db.Close()

	userID := int64(42)
	scheduled := time.Date(2030, 6, 1, 0, 0, 0, 0, time.UTC)
	sess, err := st.CreatePlannedAdHocSession(userID, scheduled, "07:30")
	if err != nil {
		t.Fatalf("CreatePlannedAdHocSession failed: %v", err)
	}
	if sess == nil {
		t.Fatalf("expected session, got nil")
	}
	if sess.GroupID != -1 || sess.VariantID != -1 {
		t.Errorf("expected sentinel ids -1/-1, got %d/%d", sess.GroupID, sess.VariantID)
	}
	if sess.UserID != userID {
		t.Errorf("expected userID %d, got %d", userID, sess.UserID)
	}
	if sess.Status != "pending" {
		t.Errorf("expected status pending, got %q", sess.Status)
	}
	if sess.StartedAt != nil {
		t.Errorf("expected started_at to be NULL, got %v", *sess.StartedAt)
	}
	if sess.ScheduledTime != "07:30" {
		t.Errorf("expected scheduled_time 07:30, got %q", sess.ScheduledTime)
	}
}

// TestListPendingAdHocSessions verifies that only ad-hoc, pending, due
// sessions for the requested user are returned, ordered by date+time.
func TestListPendingAdHocSessions(t *testing.T) {
	st := setupTestDB(t)
	defer st.db.Close()

	userID := int64(1)
	otherUser := int64(2)

	// Due (past) — should be returned
	dueDate := time.Date(2030, 6, 1, 0, 0, 0, 0, time.UTC)
	due, err := st.CreatePlannedAdHocSession(userID, dueDate, "07:00")
	if err != nil {
		t.Fatalf("create due session: %v", err)
	}

	// Same date, earlier time — should be first in result
	earlier, err := st.CreatePlannedAdHocSession(userID, dueDate, "06:00")
	if err != nil {
		t.Fatalf("create earlier session: %v", err)
	}

	// Future — should NOT be returned
	futureDate := time.Date(2030, 6, 2, 0, 0, 0, 0, time.UTC)
	if _, err := st.CreatePlannedAdHocSession(userID, futureDate, "07:00"); err != nil {
		t.Fatalf("create future session: %v", err)
	}

	// Already-notified ad-hoc — should NOT be returned (status filter)
	notifiedSess, err := st.CreatePlannedAdHocSession(userID, dueDate, "05:00")
	if err != nil {
		t.Fatalf("create notified ad-hoc session: %v", err)
	}
	if err := st.UpdateSessionStatus(notifiedSess.ID, "notified"); err != nil {
		t.Fatalf("flip status: %v", err)
	}

	// Other user's ad-hoc — should NOT be returned
	if _, err := st.CreatePlannedAdHocSession(otherUser, dueDate, "07:00"); err != nil {
		t.Fatalf("create other-user session: %v", err)
	}

	// A pending recurring session at the same time — should NOT be returned (group_id != -1)
	group, _ := st.CreateWorkoutGroup("G", "", false, userID, "[1]", "07:00", 15)
	variant, _ := st.CreateWorkoutVariant(group.ID, "V", intPtr(1), "")
	if _, err := st.CreateWorkoutSession(group.ID, variant.ID, userID, dueDate, "07:00"); err != nil {
		t.Fatalf("create recurring session: %v", err)
	}

	// Query at a moment after the due time but before the future date.
	now := time.Date(2030, 6, 1, 8, 0, 0, 0, time.UTC)
	got, err := st.ListPendingAdHocSessions(userID, now)
	if err != nil {
		t.Fatalf("ListPendingAdHocSessions failed: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 due ad-hoc sessions, got %d (%+v)", len(got), got)
	}
	if got[0].ID != earlier.ID {
		t.Errorf("expected earlier session first, got id %d (want %d)", got[0].ID, earlier.ID)
	}
	if got[1].ID != due.ID {
		t.Errorf("expected later session second, got id %d (want %d)", got[1].ID, due.ID)
	}

	// Query before any sessions are due.
	earlyNow := time.Date(2030, 5, 30, 0, 0, 0, 0, time.UTC)
	got, err = st.ListPendingAdHocSessions(userID, earlyNow)
	if err != nil {
		t.Fatalf("ListPendingAdHocSessions early: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("expected no sessions before due time, got %d", len(got))
	}
}

// TestListNotifiedAdHocSessions verifies that only ad-hoc sessions in
// 'notified' state for the requested user are returned, regardless of how
// far back the scheduled date sits — i.e. the result is not bounded by a
// recent-history row limit.
func TestListNotifiedAdHocSessions(t *testing.T) {
	st := setupTestDB(t)
	defer st.db.Close()

	userID := int64(1)
	otherUser := int64(2)

	// Notified ad-hoc — should be returned
	dueDate := time.Date(2030, 6, 1, 0, 0, 0, 0, time.UTC)
	notified, err := st.CreatePlannedAdHocSession(userID, dueDate, "07:00")
	if err != nil {
		t.Fatalf("create notified session: %v", err)
	}
	if err := st.UpdateSessionStatus(notified.ID, "notified"); err != nil {
		t.Fatalf("flip status: %v", err)
	}

	// Pending ad-hoc — should NOT be returned
	if _, err := st.CreatePlannedAdHocSession(userID, dueDate, "06:00"); err != nil {
		t.Fatalf("create pending session: %v", err)
	}

	// Other user's notified ad-hoc — should NOT be returned
	otherSess, err := st.CreatePlannedAdHocSession(otherUser, dueDate, "08:00")
	if err != nil {
		t.Fatalf("create other-user session: %v", err)
	}
	if err := st.UpdateSessionStatus(otherSess.ID, "notified"); err != nil {
		t.Fatalf("flip other-user status: %v", err)
	}

	// Notified recurring session — should NOT be returned (group_id != -1)
	group, _ := st.CreateWorkoutGroup("G", "", false, userID, "[1]", "07:00", 15)
	variant, _ := st.CreateWorkoutVariant(group.ID, "V", intPtr(1), "")
	rec, err := st.CreateWorkoutSession(group.ID, variant.ID, userID, dueDate, "07:00")
	if err != nil {
		t.Fatalf("create recurring session: %v", err)
	}
	if err := st.UpdateSessionStatus(rec.ID, "notified"); err != nil {
		t.Fatalf("flip recurring status: %v", err)
	}

	// Old notified ad-hoc beyond a typical history window — should still be returned
	oldDate := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	oldSess, err := st.CreatePlannedAdHocSession(userID, oldDate, "09:00")
	if err != nil {
		t.Fatalf("create old session: %v", err)
	}
	if err := st.UpdateSessionStatus(oldSess.ID, "notified"); err != nil {
		t.Fatalf("flip old status: %v", err)
	}

	got, err := st.ListNotifiedAdHocSessions(userID)
	if err != nil {
		t.Fatalf("ListNotifiedAdHocSessions failed: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 notified ad-hoc sessions for userID, got %d (%+v)", len(got), got)
	}
	// Ordered by date ASC: oldSess (2025) then notified (2030)
	if got[0].ID != oldSess.ID || got[1].ID != notified.ID {
		t.Errorf("unexpected order: got ids [%d, %d], want [%d, %d]", got[0].ID, got[1].ID, oldSess.ID, notified.ID)
	}
}
