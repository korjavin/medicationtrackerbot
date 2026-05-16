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

	if err := db.Settings.SetWorkoutEnabled(context.Background(), true); err != nil {
		t.Fatalf("SetWorkoutEnabled: %v", err)
	}
	if err := db.TZ.RecordTimezone("UTC"); err != nil {
		t.Fatalf("RecordTimezone: %v", err)
	}

	mock := &MockNotifier{}
	sched := New(db, 123456, []notifier.Notifier{mock})
	sched.WorkoutChecker.workoutSvc = workoutsvc.New(db.Workout, db.TZ)
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
	session, err := db.Workout.CreatePlannedAdHocSession(123456, scheduledDate, future.Format("15:04"))
	if err != nil {
		t.Fatalf("CreatePlannedAdHocSession: %v", err)
	}

	if err := sched.WorkoutChecker.Check(context.Background()); err != nil {
		t.Fatalf("Check: %v", err)
	}

	time.Sleep(50 * time.Millisecond)

	if got := len(mock.snapshotNotifications()); got != 0 {
		t.Errorf("expected 0 notifications for a future ad-hoc, got %d", got)
	}

	updated, err := db.Workout.GetSession(session.ID)
	if err != nil {
		t.Fatalf("GetSession: %v", err)
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
	session, err := db.Workout.CreatePlannedAdHocSession(123456, scheduledDate, "09:00")
	if err != nil {
		t.Fatalf("CreatePlannedAdHocSession: %v", err)
	}

	if _, err := db.Workout.LogExerciseWithSource(session.ID, 0, "Goblet Squat", nil, nil, nil, "", "", "schedule"); err != nil {
		t.Fatalf("LogExerciseWithSource: %v", err)
	}
	if _, err := db.Workout.LogExerciseWithSource(session.ID, 0, "Push-up", nil, nil, nil, "", "", "schedule"); err != nil {
		t.Fatalf("LogExerciseWithSource: %v", err)
	}

	if err := sched.WorkoutChecker.Check(context.Background()); err != nil {
		t.Fatalf("Check: %v", err)
	}

	time.Sleep(50 * time.Millisecond)

	notes := mock.snapshotNotifications()
	if got := len(notes); got != 1 {
		t.Fatalf("expected 1 notification, got %d", got)
	}
	body := notes[0].Text
	if !strings.Contains(body, "Goblet Squat") {
		t.Errorf("notification body should list Goblet Squat, got: %s", body)
	}
	if !strings.Contains(body, "Push-up") {
		t.Errorf("notification body should list Push-up, got: %s", body)
	}
	if got := notes[0].Metadata["ad_hoc"]; got != true {
		t.Errorf("metadata ad_hoc = %v, want true", got)
	}

	updated, err := db.Workout.GetSession(session.ID)
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if updated.Status != "notified" {
		t.Errorf("status = %q, want notified", updated.Status)
	}
}

// TestAdHocScheduledMoment_WestOfUTC verifies that reconstructing the
// scheduled moment from a stored UTC-midnight scheduled_date does not shift
// the calendar day for west-of-UTC users. Regression for a bug that caused
// the 3h re-notify and 6h auto-skip to fire immediately after first
// notification because the moment was computed for the previous day.
func TestAdHocScheduledMoment_WestOfUTC(t *testing.T) {
	// stored as the handler stores it: time.Parse("2006-01-02", ...) yields
	// UTC midnight on the user's intended calendar day.
	sess := &store.WorkoutSession{
		ScheduledDate: time.Date(2030, 6, 15, 0, 0, 0, 0, time.UTC),
		ScheduledTime: "07:30",
	}

	for _, tz := range []string{"UTC", "Asia/Tokyo", "America/New_York", "Pacific/Honolulu"} {
		t.Run(tz, func(t *testing.T) {
			loc, err := time.LoadLocation(tz)
			if err != nil {
				t.Skipf("LoadLocation(%q) unavailable on host: %v", tz, err)
			}
			got := adHocScheduledMoment(sess, loc)
			if got.Year() != 2030 || got.Month() != time.June || got.Day() != 15 {
				t.Errorf("expected calendar date 2030-06-15, got %v", got)
			}
			if got.Hour() != 7 || got.Minute() != 30 {
				t.Errorf("expected 07:30 wall-clock, got %v", got)
			}
			if got.Location().String() != tz {
				t.Errorf("expected location %q, got %q", tz, got.Location().String())
			}
		})
	}
}

// TestWorkoutChecker_AdHocDue_EscapesMarkdownInExerciseNames verifies that
// free-form exercise names containing Telegram Markdown V1 special chars (e.g.
// "pull_up", "set [A]") are escaped in the notification body — otherwise
// Telegram rejects the message with "can't parse entities" and the user never
// sees it.
func TestWorkoutChecker_AdHocDue_EscapesMarkdownInExerciseNames(t *testing.T) {
	sched, db, mock := adhocSetup(t)

	scheduled := time.Date(2026, 5, 6, 9, 0, 0, 0, time.UTC)
	now := scheduled.Add(2 * time.Minute)
	sched.WorkoutChecker.now = func() time.Time { return now }

	scheduledDate := time.Date(scheduled.Year(), scheduled.Month(), scheduled.Day(), 0, 0, 0, 0, time.UTC)
	session, err := db.Workout.CreatePlannedAdHocSession(123456, scheduledDate, "09:00")
	if err != nil {
		t.Fatalf("CreatePlannedAdHocSession: %v", err)
	}

	if _, err := db.Workout.LogExerciseWithSource(session.ID, 0, "pull_up", nil, nil, nil, "", "", "schedule"); err != nil {
		t.Fatalf("LogExerciseWithSource: %v", err)
	}
	if _, err := db.Workout.LogExerciseWithSource(session.ID, 0, "set [A]", nil, nil, nil, "", "", "schedule"); err != nil {
		t.Fatalf("LogExerciseWithSource: %v", err)
	}

	if err := sched.WorkoutChecker.Check(context.Background()); err != nil {
		t.Fatalf("Check: %v", err)
	}
	time.Sleep(50 * time.Millisecond)

	notes := mock.snapshotNotifications()
	if got := len(notes); got != 1 {
		t.Fatalf("expected 1 notification, got %d", got)
	}
	body := notes[0].Text
	if !strings.Contains(body, `pull\_up`) {
		t.Errorf("expected escaped underscore in body, got: %s", body)
	}
	if !strings.Contains(body, `set \[A]`) {
		t.Errorf("expected escaped bracket in body, got: %s", body)
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
	session, err := db.Workout.CreatePlannedAdHocSession(123456, scheduledDate, "09:00")
	if err != nil {
		t.Fatalf("CreatePlannedAdHocSession: %v", err)
	}

	if err := sched.WorkoutChecker.Check(context.Background()); err != nil {
		t.Fatalf("Check: %v", err)
	}

	time.Sleep(50 * time.Millisecond)

	notes := mock.snapshotNotifications()
	if got := len(notes); got != 1 {
		t.Fatalf("expected 1 notification, got %d", got)
	}
	body := notes[0].Text
	if !strings.Contains(body, "Workout starting now") {
		t.Errorf("notification body should mention workout starting, got: %s", body)
	}
	if !strings.Contains(body, "No exercises planned") {
		t.Errorf("expected generic-message marker, got: %s", body)
	}

	updated, err := db.Workout.GetSession(session.ID)
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if updated.Status != "notified" {
		t.Errorf("status = %q, want notified", updated.Status)
	}
}
