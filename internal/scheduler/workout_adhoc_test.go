package scheduler

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	workoutsvc "github.com/korjavin/medicationtrackerbot/internal/workout"
)

// adhocSetup spins up a scheduler wired to an in-memory store with the
// workout feature enabled and the user's timezone fixed to UTC. Returns the
// scheduler, the store, and a mock notifier that captures Send/Delete calls.
func adhocSetup(t *testing.T) (*Scheduler, *store.Store, *MockNotifier) {
	t.Helper()
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	if err := db.SetWorkoutEnabled(context.Background(), true); err != nil {
		t.Fatalf("SetWorkoutEnabled: %v", err)
	}
	if err := db.RecordTimezone("UTC"); err != nil {
		t.Fatalf("RecordTimezone: %v", err)
	}

	mock := &MockNotifier{}
	sched := New(db, 123456, []notifier.Notifier{mock})
	sched.WorkoutChecker.workoutSvc = workoutsvc.New(db)
	sched.WorkoutChecker.daysCache = make(map[string][]int)
	return sched, db, mock
}

// TestWorkoutChecker_AdHocFuture_NotNotified verifies that a pending ad-hoc
// session whose scheduled moment is still in the future is left untouched.
func TestWorkoutChecker_AdHocFuture_NotNotified(t *testing.T) {
	sched, db, mock := adhocSetup(t)

	now := time.Date(2026, 5, 6, 12, 0, 0, 0, time.UTC)
	future := now.Add(2 * time.Hour) // 14:00 UTC same day
	sched.WorkoutChecker.now = func() time.Time { return now }

	scheduledDate := time.Date(future.Year(), future.Month(), future.Day(), 0, 0, 0, 0, time.UTC)
	session, err := db.CreatePlannedAdHocSession(123456, scheduledDate, future.Format("15:04"))
	if err != nil {
		t.Fatalf("CreatePlannedAdHocSession: %v", err)
	}

	if err := sched.WorkoutChecker.Check(context.Background()); err != nil {
		t.Fatalf("Check: %v", err)
	}

	time.Sleep(50 * time.Millisecond)

	if got := len(mock.Notifications); got != 0 {
		t.Errorf("expected 0 notifications for a future ad-hoc, got %d", got)
	}

	updated, err := db.GetWorkoutSession(session.ID)
	if err != nil {
		t.Fatalf("GetWorkoutSession: %v", err)
	}
	if updated.Status != "pending" {
		t.Errorf("status = %q, want pending (untouched)", updated.Status)
	}
}

// TestWorkoutChecker_AdHocDue_NotifiedAndFlipped verifies the happy path: a
// pending ad-hoc session whose scheduled moment has arrived produces a
// workout-due notification listing the planned exercises and is flipped to
// 'notified'.
func TestWorkoutChecker_AdHocDue_NotifiedAndFlipped(t *testing.T) {
	sched, db, mock := adhocSetup(t)

	scheduled := time.Date(2026, 5, 6, 9, 0, 0, 0, time.UTC)
	now := scheduled.Add(2 * time.Minute) // just after the scheduled moment
	sched.WorkoutChecker.now = func() time.Time { return now }

	scheduledDate := time.Date(scheduled.Year(), scheduled.Month(), scheduled.Day(), 0, 0, 0, 0, time.UTC)
	session, err := db.CreatePlannedAdHocSession(123456, scheduledDate, "09:00")
	if err != nil {
		t.Fatalf("CreatePlannedAdHocSession: %v", err)
	}

	if _, err := db.LogExerciseWithSource(session.ID, 0, "Goblet Squat", nil, nil, nil, "", "", "schedule"); err != nil {
		t.Fatalf("LogExerciseWithSource: %v", err)
	}
	if _, err := db.LogExerciseWithSource(session.ID, 0, "Push-up", nil, nil, nil, "", "", "schedule"); err != nil {
		t.Fatalf("LogExerciseWithSource: %v", err)
	}

	if err := sched.WorkoutChecker.Check(context.Background()); err != nil {
		t.Fatalf("Check: %v", err)
	}

	time.Sleep(50 * time.Millisecond)

	if got := len(mock.Notifications); got != 1 {
		t.Fatalf("expected 1 notification, got %d", got)
	}
	body := mock.Notifications[0].Text
	if !strings.Contains(body, "Goblet Squat") {
		t.Errorf("notification body should list Goblet Squat, got: %s", body)
	}
	if !strings.Contains(body, "Push-up") {
		t.Errorf("notification body should list Push-up, got: %s", body)
	}
	if got := mock.Notifications[0].Metadata["ad_hoc"]; got != true {
		t.Errorf("metadata ad_hoc = %v, want true", got)
	}

	updated, err := db.GetWorkoutSession(session.ID)
	if err != nil {
		t.Fatalf("GetWorkoutSession: %v", err)
	}
	if updated.Status != "notified" {
		t.Errorf("status = %q, want notified", updated.Status)
	}
}

// TestWorkoutChecker_AdHocDue_NoExercises_GenericMessage covers the edge case
// where a user scheduled a one-off without specifying any exercises: the
// scheduler must still notify them, with a generic body.
func TestWorkoutChecker_AdHocDue_NoExercises_GenericMessage(t *testing.T) {
	sched, db, mock := adhocSetup(t)

	scheduled := time.Date(2026, 5, 6, 9, 0, 0, 0, time.UTC)
	now := scheduled.Add(time.Minute)
	sched.WorkoutChecker.now = func() time.Time { return now }

	scheduledDate := time.Date(scheduled.Year(), scheduled.Month(), scheduled.Day(), 0, 0, 0, 0, time.UTC)
	session, err := db.CreatePlannedAdHocSession(123456, scheduledDate, "09:00")
	if err != nil {
		t.Fatalf("CreatePlannedAdHocSession: %v", err)
	}

	if err := sched.WorkoutChecker.Check(context.Background()); err != nil {
		t.Fatalf("Check: %v", err)
	}

	time.Sleep(50 * time.Millisecond)

	if got := len(mock.Notifications); got != 1 {
		t.Fatalf("expected 1 notification, got %d", got)
	}
	body := mock.Notifications[0].Text
	if !strings.Contains(body, "Workout starting now") {
		t.Errorf("notification body should mention workout starting, got: %s", body)
	}
	if !strings.Contains(body, "No exercises planned") {
		t.Errorf("expected generic-message marker, got: %s", body)
	}

	updated, err := db.GetWorkoutSession(session.ID)
	if err != nil {
		t.Fatalf("GetWorkoutSession: %v", err)
	}
	if updated.Status != "notified" {
		t.Errorf("status = %q, want notified", updated.Status)
	}
}
