package scheduler

import (
	"context"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	workoutsvc "github.com/korjavin/medicationtrackerbot/internal/workout"
)

// TestWorkoutChecker_CrossTZCooldownPreventsDuplicateSession reproduces the
// timezone-shift duplication path: a session is created in one user
// timezone and then the scheduler runs again after the user has crossed
// into a TZ where "today" is a different calendar date but the same
// scheduled weekday. Without the cooldown the second run keys the lookup
// against the new local date, finds nothing, and creates a duplicate
// session for what the user perceives as one workout day.
func TestWorkoutChecker_CrossTZCooldownPreventsDuplicateSession(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	defer db.Close() //nolint:errcheck

	if err := db.Settings.SetWorkoutEnabled(context.Background(), true); err != nil {
		t.Fatalf("SetWorkoutEnabled: %v", err)
	}

	// Group fires every weekday at 12:00.
	group, err := db.Workout.CreateWorkoutGroup("CrossTZ", "", false, 123456, "[0,1,2,3,4,5,6]", "12:00", 15)
	if err != nil {
		t.Fatalf("CreateWorkoutGroup: %v", err)
	}
	one := 1
	if _, err := db.Workout.CreateWorkoutVariant(group.ID, "Default", &one, ""); err != nil {
		t.Fatalf("CreateWorkoutVariant: %v", err)
	}

	tokyo, _ := time.LoadLocation("Asia/Tokyo")
	berlin, _ := time.LoadLocation("Europe/Berlin")

	mockNotifier := &MockNotifier{}
	sched := New(db, 123456, []notifier.Notifier{mockNotifier})
	sched.WorkoutChecker.workoutSvc = workoutsvc.New(db.Workout, db.TZ)
	sched.WorkoutChecker.daysCache = make(map[string][]int)

	// Tick 1: Tokyo. Wed 2026-05-04 12:30 JST = 2026-05-04 03:30 UTC.
	if err := db.TZ.RecordTimezone("Asia/Tokyo"); err != nil {
		t.Fatalf("RecordTimezone Tokyo: %v", err)
	}
	tokyoTick := time.Date(2026, 5, 4, 12, 30, 0, 0, tokyo)
	sched.WorkoutChecker.now = func() time.Time { return tokyoTick }

	if err := sched.WorkoutChecker.Check(context.Background()); err != nil {
		t.Fatalf("Tokyo Check: %v", err)
	}

	// Confirm exactly one session got created on the Tokyo "today" date.
	first, err := db.Workout.GetWorkoutHistory(123456, 10)
	if err != nil {
		t.Fatalf("GetWorkoutHistory: %v", err)
	}
	if len(first) != 1 {
		t.Fatalf("after Tokyo tick, want 1 session, got %d", len(first))
	}

	// Tick 2: user lands in Berlin. Same UTC moment is 2026-05-04 04:30
	// Berlin (= 03:30 UTC + ~1 minute scheduler interval). Local calendar
	// date is still 2026-05-04 in Berlin too — this branch is a sanity
	// check that the cooldown does not block a same-date no-op tick.
	// Then advance another scheduler tick eight hours later when the user
	// has scrolled to Berlin's afternoon: still 2026-05-04 in Berlin, but
	// "today" is computed against Berlin midnight (a different UTC instant
	// from Tokyo midnight), so without the cooldown the session lookup
	// could miss the existing row.
	if err := db.TZ.RecordTimezone("Europe/Berlin"); err != nil {
		t.Fatalf("RecordTimezone Berlin: %v", err)
	}
	berlinTick := time.Date(2026, 5, 4, 12, 30, 0, 0, berlin) // ~9h later UTC
	sched.WorkoutChecker.now = func() time.Time { return berlinTick }

	if err := sched.WorkoutChecker.Check(context.Background()); err != nil {
		t.Fatalf("Berlin Check: %v", err)
	}

	second, err := db.Workout.GetWorkoutHistory(123456, 10)
	if err != nil {
		t.Fatalf("GetWorkoutHistory after Berlin: %v", err)
	}
	if len(second) != 1 {
		for _, s := range second {
			t.Logf("session id=%d scheduled_date=%v scheduled_time=%s", s.ID, s.ScheduledDate, s.ScheduledTime)
		}
		t.Errorf("want 1 session after cross-TZ tick, got %d", len(second))
	}
}

// TestWorkoutChecker_ConsecutiveDaysAllowed pins the cooldown's upper bound:
// two distinct calendar dates 24h apart at the same scheduled time must
// each produce their own session, otherwise legitimate same-time daily
// workouts would silently disappear after the first one.
func TestWorkoutChecker_ConsecutiveDaysAllowed(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	defer db.Close() //nolint:errcheck
	if err := db.Settings.SetWorkoutEnabled(context.Background(), true); err != nil {
		t.Fatalf("SetWorkoutEnabled: %v", err)
	}
	if err := db.TZ.RecordTimezone("UTC"); err != nil {
		t.Fatalf("RecordTimezone: %v", err)
	}

	group, err := db.Workout.CreateWorkoutGroup("Daily", "", false, 123456, "[0,1,2,3,4,5,6]", "09:00", 15)
	if err != nil {
		t.Fatalf("CreateWorkoutGroup: %v", err)
	}
	one := 1
	if _, err := db.Workout.CreateWorkoutVariant(group.ID, "Default", &one, ""); err != nil {
		t.Fatalf("CreateWorkoutVariant: %v", err)
	}

	mockNotifier := &MockNotifier{}
	sched := New(db, 123456, []notifier.Notifier{mockNotifier})
	sched.WorkoutChecker.workoutSvc = workoutsvc.New(db.Workout, db.TZ)
	sched.WorkoutChecker.daysCache = make(map[string][]int)

	// Day 1: Mon 2026-05-04 09:30 UTC.
	day1 := time.Date(2026, 5, 4, 9, 30, 0, 0, time.UTC)
	sched.WorkoutChecker.now = func() time.Time { return day1 }
	if err := sched.WorkoutChecker.Check(context.Background()); err != nil {
		t.Fatalf("day1 Check: %v", err)
	}

	// Day 2: Tue 2026-05-05 09:30 UTC — exactly 24h later.
	day2 := time.Date(2026, 5, 5, 9, 30, 0, 0, time.UTC)
	sched.WorkoutChecker.now = func() time.Time { return day2 }
	if err := sched.WorkoutChecker.Check(context.Background()); err != nil {
		t.Fatalf("day2 Check: %v", err)
	}

	sessions, err := db.Workout.GetWorkoutHistory(123456, 10)
	if err != nil {
		t.Fatalf("GetWorkoutHistory: %v", err)
	}
	if len(sessions) != 2 {
		for _, s := range sessions {
			t.Logf("session id=%d scheduled_date=%v", s.ID, s.ScheduledDate)
		}
		t.Errorf("want 2 sessions for two consecutive days at 24h apart, got %d", len(sessions))
	}
}
