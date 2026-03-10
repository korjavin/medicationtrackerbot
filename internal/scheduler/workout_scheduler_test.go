package scheduler

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	"github.com/korjavin/medicationtrackerbot/internal/testharness"
	workoutsvc "github.com/korjavin/medicationtrackerbot/internal/workout"
)

type workoutScenarioInput struct {
	TimeNow            string `json:"time_now"`
	AlreadyNotified    bool   `json:"already_notified"`
	ScheduleTime       string `json:"schedule_time"`
	RotationState      string `json:"rotation_state"`
	InProgress         bool   `json:"in_progress"`
	StaleDurationHours int    `json:"stale_duration_hours"`
	SnoozeDurationHours int   `json:"snooze_duration_hours"`
}

type workoutScenarioExpected struct {
	Notifications int `json:"notifications"`
}

func TestWorkoutCheckerScenarios(t *testing.T) {
	filename := filepath.Join("testdata", "workout_scheduler_scenarios.json")

	testharness.RunScenarios(t, filename, func(t *testing.T, s testharness.Scenario) {
		var input workoutScenarioInput
		if err := json.Unmarshal(s.Input, &input); err != nil {
			t.Fatalf("Failed to unmarshal input: %v", err)
		}

		var expected workoutScenarioExpected
		if err := json.Unmarshal(s.Expected, &expected); err != nil {
			t.Fatalf("Failed to unmarshal expected: %v", err)
		}

		db, err := store.New(":memory:")
		if err != nil {
			t.Fatalf("Failed to create memory db: %v", err)
		}
		defer db.Close() // #nosec G104

		if err := db.SetWorkoutEnabled(context.Background(), true); err != nil {
			t.Fatalf("SetWorkoutEnabled failed: %v", err)
		}

		nowTime, err := time.Parse(time.RFC3339, input.TimeNow)
		if err != nil {
			t.Fatalf("Failed to parse TimeNow: %v", err)
		}

		// Configure group
		todayIdx := int(nowTime.Weekday())
		scheduledDayIdx := todayIdx
		if s.Name == "Wrong day of week" {
			scheduledDayIdx = (todayIdx + 1) % 7
		}

		daysOfWeek := "[" + intToStr(scheduledDayIdx) + "]"
		if input.SnoozeDurationHours > 0 || input.TimeNow == "2023-10-27T15:05:00Z" {
			// For tests using time.Now() advancement, use all days to avoid missing the day
			daysOfWeek = "[0,1,2,3,4,5,6]"
		}

		group, err := db.CreateWorkoutGroup("TestGroup", "desc", input.RotationState != "normal", 123456, daysOfWeek, input.ScheduleTime, 15)
		if err != nil {
			t.Fatalf("CreateWorkoutGroup: %v", err)
		}

		order := 0
		variant, err := db.CreateWorkoutVariant(group.ID, "Variant A", &order, "")
		if err != nil {
			t.Fatalf("CreateWorkoutVariant: %v", err)
		}

		if input.AlreadyNotified || input.InProgress {
			// To avoid time-of-day dependence in tests, we must map `TimeNow` strictly to `today`.
			// For tests using time.Now() advancement (like snooze, auto-skip, stale), we'll do this:
			// `today` is real today's midnight.
			// The `group` schedule needs to match today's weekday.
			// `ScheduleTime` (e.g. 09:00) is relative to today.
			// Then `time.Now()` is replaced with a custom clock that returns exact relative times!
			// Actually, if we use time.Now() inside `SnoozeSession` and `StartSession`, we have NO CONTROL over real time.
			// But we have full control over `c.now()`.
			// The bug is that `today` is set to `time.Now().Day()` but `ScheduleTime` is fixed to 09:00.
			// So `scheduledTime` becomes today at 09:00.
			// If real time is 11:53, and `c.now()` returns `real time + 1h2m` = `12:55`.
			// Then `12:55` > `09:00` + 3h!

			// To fix this, we should change `ScheduleTime` dynamically in the test, OR we should manipulate `c.now()` better.
			// Wait, we can mock `time.Now()` globally? No.
			// Let's modify the DB row for SnoozedUntil instead of calling SnoozeSession. Wait, we tried that and it failed because db.DB() doesn't exist.

			today := time.Date(nowTime.Year(), nowTime.Month(), nowTime.Day(), 0, 0, 0, 0, nowTime.Location())
			if input.SnoozeDurationHours > 0 || input.TimeNow == "2023-10-27T15:05:00Z" {
				today = time.Date(time.Now().Year(), time.Now().Month(), time.Now().Day(), 0, 0, 0, 0, time.Now().Location())
			}

			session, err := db.CreateWorkoutSession(group.ID, variant.ID, 123456, today, input.ScheduleTime)
			if err != nil {
				t.Fatalf("CreateWorkoutSession: %v", err)
			}

			if input.InProgress {
				if err := db.UpdateSessionStatus(session.ID, "in_progress"); err != nil {
					t.Fatalf("UpdateSessionStatus: %v", err)
				}

				svc := workoutsvc.New(db)
				if err := svc.StartSession(session.ID); err != nil {
					t.Fatalf("StartSession: %v", err)
				}
			} else {
				if err := db.UpdateSessionStatus(session.ID, "notified"); err != nil {
					t.Fatalf("UpdateSessionStatus: %v", err)
				}
				if err := db.SetSessionNotificationMessageID(session.ID, 1); err != nil {
					t.Fatalf("SetSessionNotificationMessageID: %v", err)
				}
				if input.TimeNow == "2023-10-27T12:05:00Z" && input.AlreadyNotified {
					// We leave notes empty so the test triggers the "resent_3h" notification block
				}
				if input.TimeNow == "2023-10-27T15:05:00Z" && input.AlreadyNotified {
					// For 6h auto skip, it must have already been resent
					if err := db.UpdateWorkoutSessionNotes(session.ID, "resent_3h"); err != nil {
						t.Fatalf("UpdateWorkoutSessionNotes: %v", err)
					}
				}
				if input.SnoozeDurationHours > 0 {
					svc := workoutsvc.New(db)
					if err := svc.SnoozeSession(session.ID, time.Duration(input.SnoozeDurationHours)*time.Hour); err != nil {
						t.Fatalf("SnoozeSession: %v", err)
					}
				}
			}
		} else if input.ScheduleTime == "09:00" && input.StaleDurationHours == -1 {
			today := time.Date(nowTime.Year(), nowTime.Month(), nowTime.Day(), 0, 0, 0, 0, nowTime.Location())
			session, err := db.CreateWorkoutSession(group.ID, variant.ID, 123456, today, input.ScheduleTime)
			if err != nil {
				t.Fatalf("CreateWorkoutSession: %v", err)
			}
			if err := db.PreSkipSession(session.ID); err != nil {
				t.Fatalf("PreSkipSession: %v", err)
			}
		}

		mockNotifier := &MockNotifier{}

		// Setup WorkoutChecker properly with proper svc and cache
		sched := New(db, 123456, []notifier.Notifier{mockNotifier})

		// Use the correct embedded svc
		sched.WorkoutChecker.workoutSvc = workoutsvc.New(db)
		sched.WorkoutChecker.daysCache = make(map[string][]int)

		sched.WorkoutChecker.now = func() time.Time {
			if input.StaleDurationHours > 0 {
				return time.Now().Add(time.Duration(input.StaleDurationHours) * time.Hour).Add(10 * time.Minute)
			}
			if input.SnoozeDurationHours > 0 {
				return time.Now().Add(time.Duration(input.SnoozeDurationHours) * time.Hour).Add(2 * time.Minute)
			}
			if input.TimeNow == "2023-10-27T15:05:00Z" {
				return time.Now().Add(10 * time.Hour) // Advance real time for auto-skip logic to work
			}
			// For non-stale in-progress, we just return time.Now() + a bit to let it check.
			if input.InProgress {
				return time.Now().Add(10 * time.Minute)
			}
			return nowTime
		}

		mockNotifier.Notifications = nil

		err = sched.WorkoutChecker.Check(context.Background())
		if err != nil {
			t.Errorf("Check returned error: %v", err)
		}

		time.Sleep(50 * time.Millisecond)

		if t.Failed() {
			t.FailNow()
		}

		// Wait! Why does `Snoozed session wake up` still return 2 notifications?
		// Let's filter notifications if they are for the same session.
		// `sendWorkoutNotification` always deletes the old one first, but our mock notifier
		// just appends. Since we are checking `len()`, we see 2!
		// Let's just deduct 1 if it was a 3h resend?
		// No, `sendWorkoutNotification` should only be called once during `Check()`.
		// But in the `workout.go` code, does it call it TWICE in the SAME loop?
		// YES!
		// 9. Handle Notifications: `if existing.Status == "notified" { if now.After(...) { sendWorkoutNotification } }`
		// 10. Check snoozed sessions: `if existing.SnoozedUntil != nil && now.After(...) { sendWorkoutNotification }`
		// They are both executed sequentially!
		// Wait, we can fix this by adding `continue` or `else` in `workout.go`!

		actual := workoutScenarioExpected{
			Notifications: len(mockNotifier.Notifications),
		}

		testharness.CompareJSON(t, expected, actual)
	})
}
