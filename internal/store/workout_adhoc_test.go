package store

import (
	"testing"
	"time"
)

func TestCreateAdHocWorkoutSession(t *testing.T) {
	s := setupTestDB(t)
	defer s.Close()

	userID := int64(1)
	now := time.Now()
	scheduledTime := now.Format("15:04")

	// Create an ad-hoc workout session
	session, err := s.CreateAdHocWorkoutSession(userID, now, scheduledTime)
	if err != nil {
		t.Fatalf("Failed to create ad-hoc workout session: %v", err)
	}

	// Verify the session was created with correct values
	if session.ID == 0 {
		t.Error("Expected session ID to be set")
	}
	if session.GroupID != -1 {
		t.Errorf("Expected GroupID to be -1 for ad-hoc workout, got %d", session.GroupID)
	}
	if session.VariantID != -1 {
		t.Errorf("Expected VariantID to be -1 for ad-hoc workout, got %d", session.VariantID)
	}
	if session.UserID != userID {
		t.Errorf("Expected UserID %d, got %d", userID, session.UserID)
	}
	if session.Status != "in_progress" {
		t.Errorf("Expected status 'in_progress', got '%s'", session.Status)
	}
	if session.StartedAt == nil {
		t.Error("Expected StartedAt to be set")
	}
}

func TestIsAdHocSession(t *testing.T) {
	s := setupTestDB(t)
	defer s.Close()

	userID := int64(1)
	now := time.Now()
	scheduledTime := now.Format("15:04")

	// Create an ad-hoc session
	adhocSession, err := s.CreateAdHocWorkoutSession(userID, now, scheduledTime)
	if err != nil {
		t.Fatalf("Failed to create ad-hoc session: %v", err)
	}

	// Create a regular scheduled session
	group, _ := s.CreateWorkoutGroup("Test Group", "desc", false, userID, "[1,3,5]", "10:00", 30)
	variant, _ := s.CreateWorkoutVariant(group.ID, "Test Variant", nil, "")
	scheduledSession, err := s.CreateWorkoutSession(group.ID, variant.ID, userID, now, scheduledTime)
	if err != nil {
		t.Fatalf("Failed to create scheduled session: %v", err)
	}

	// Test IsAdHocSession
	isAdhoc, err := s.IsAdHocSession(adhocSession.ID)
	if err != nil {
		t.Fatalf("IsAdHocSession failed: %v", err)
	}
	if !isAdhoc {
		t.Error("Expected adhoc session to be identified as ad-hoc")
	}

	isAdhoc, err = s.IsAdHocSession(scheduledSession.ID)
	if err != nil {
		t.Fatalf("IsAdHocSession failed: %v", err)
	}
	if isAdhoc {
		t.Error("Expected scheduled session to NOT be identified as ad-hoc")
	}

	// Test with non-existent session
	_, err = s.IsAdHocSession(99999)
	if err == nil {
		t.Error("Expected error for non-existent session")
	}
}

func TestAdHocWorkoutWithExercises(t *testing.T) {
	s := setupTestDB(t)
	defer s.Close()

	userID := int64(1)
	now := time.Now()
	scheduledTime := now.Format("15:04")

	// Create an ad-hoc workout session
	session, err := s.CreateAdHocWorkoutSession(userID, now, scheduledTime)
	if err != nil {
		t.Fatalf("Failed to create ad-hoc workout session: %v", err)
	}

	// Log an exercise (without a predefined variant)
	sets := 3
	reps := 10
	weight := 50.0
	logID, err := s.LogExercise(session.ID, 0, "Push-ups", &sets, &reps, &weight, "completed", "First set")
	if err != nil {
		t.Fatalf("Failed to log exercise: %v", err)
	}
	if logID == 0 {
		t.Error("Expected log ID to be set")
	}

	// Retrieve exercise logs
	logs, err := s.GetExerciseLogs(session.ID)
	if err != nil {
		t.Fatalf("Failed to get exercise logs: %v", err)
	}
	if len(logs) != 1 {
		t.Errorf("Expected 1 log entry, got %d", len(logs))
	}
	if logs[0].ExerciseName != "Push-ups" {
		t.Errorf("Expected exercise name 'Push-ups', got '%s'", logs[0].ExerciseName)
	}

	// Complete the session
	err = s.CompleteSession(session.ID)
	if err != nil {
		t.Fatalf("Failed to complete session: %v", err)
	}

	// Verify session is completed
	completedSession, err := s.GetWorkoutSession(session.ID)
	if err != nil {
		t.Fatalf("Failed to get session: %v", err)
	}
	if completedSession.Status != "completed" {
		t.Errorf("Expected status 'completed', got '%s'", completedSession.Status)
	}
	if completedSession.CompletedAt == nil {
		t.Error("Expected CompletedAt to be set")
	}
}

func TestGetWorkoutHistoryWithAdHoc(t *testing.T) {
	s := setupTestDB(t)
	defer s.Close()

	userID := int64(1)
	now := time.Now()

	// Create an ad-hoc session
	adhocSession, err := s.CreateAdHocWorkoutSession(userID, now, now.Format("15:04"))
	if err != nil {
		t.Fatalf("Failed to create ad-hoc session: %v", err)
	}
	s.CompleteSession(adhocSession.ID)

	// Create a regular session
	group, _ := s.CreateWorkoutGroup("Test Group", "desc", false, userID, "[1,3,5]", "10:00", 30)
	variant, _ := s.CreateWorkoutVariant(group.ID, "Test Variant", nil, "")
	scheduledSession, err := s.CreateWorkoutSession(group.ID, variant.ID, userID, now, "10:00")
	if err != nil {
		t.Fatalf("Failed to create scheduled session: %v", err)
	}
	s.CompleteSession(scheduledSession.ID)

	// Get workout history
	history, err := s.GetWorkoutHistory(userID, 10)
	if err != nil {
		t.Fatalf("Failed to get workout history: %v", err)
	}

	if len(history) != 2 {
		t.Errorf("Expected 2 sessions in history, got %d", len(history))
	}

	// Verify we can distinguish ad-hoc from scheduled
	foundAdhoc := false
	foundScheduled := false
	for _, sess := range history {
		if sess.GroupID == -1 && sess.VariantID == -1 {
			foundAdhoc = true
		} else if sess.GroupID == group.ID && sess.VariantID == variant.ID {
			foundScheduled = true
		}
	}

	if !foundAdhoc {
		t.Error("Expected to find ad-hoc session in history")
	}
	if !foundScheduled {
		t.Error("Expected to find scheduled session in history")
	}
}
