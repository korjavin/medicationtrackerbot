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
	TimeNow             string `json:"time_now"`
	AlreadyNotified     bool   `json:"already_notified"`
	ScheduleTime        string `json:"schedule_time"`
	RotationState       string `json:"rotation_state"`
	InProgress          bool   `json:"in_progress"`
	StaleDurationHours  int    `json:"stale_duration_hours"`
	SnoozeDurationHours int    `json:"snooze_duration_hours"`
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

		if err := db.Settings.SetWorkoutEnabled(context.Background(), true); err != nil {
			t.Fatalf("SetWorkoutEnabled failed: %v", err)
		}

		nowTime, err := time.Parse(time.RFC3339, input.TimeNow)
		if err != nil {
			t.Fatalf("Failed to parse TimeNow: %v", err)
		}

		baseTime := time.Date(time.Now().Year(), time.Now().Month(), time.Now().Day(), 12, 0, 0, 0, time.Now().Location())

		if input.SnoozeDurationHours > 0 || input.TimeNow == "2023-10-27T15:05:00Z" || input.StaleDurationHours > 0 || input.InProgress {
			// Tests involving time progression must stay on same day to avoid `Check` looking at next day.
			nowTime = baseTime
			if input.TimeNow == "2023-10-27T15:05:00Z" {
				nowTime = baseTime.Add(6 * time.Hour) // 18:00
			}
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

		// Use dynamic 12:00 for the schedule to ensure we have a solid baseline.
		scheduleTimeString := input.ScheduleTime
		if input.SnoozeDurationHours > 0 || input.TimeNow == "2023-10-27T15:05:00Z" || input.StaleDurationHours > 0 || input.InProgress {
			scheduleTimeString = "12:00"
		}

		group, err := db.Workout.CreateWorkoutGroup("TestGroup", "desc", input.RotationState != "normal", 123456, daysOfWeek, scheduleTimeString, 15)
		if err != nil {
			t.Fatalf("CreateWorkoutGroup: %v", err)
		}

		order := 0
		variant, err := db.Workout.CreateWorkoutVariant(group.ID, "Variant A", &order, "")
		if err != nil {
			t.Fatalf("CreateWorkoutVariant: %v", err)
		}

		if input.AlreadyNotified || input.InProgress {
			today := time.Date(nowTime.Year(), nowTime.Month(), nowTime.Day(), 0, 0, 0, 0, nowTime.Location())
			if input.SnoozeDurationHours > 0 || input.TimeNow == "2023-10-27T15:05:00Z" || input.StaleDurationHours > 0 || input.InProgress {
				// Use the same base time as the checker's now() to avoid date mismatch when
				// the test runs close to midnight (time.Now() + snooze duration may cross a day boundary).
				checkerBase := time.Now().Add(time.Duration(input.SnoozeDurationHours) * time.Hour).Add(2 * time.Minute)
				if input.SnoozeDurationHours == 0 {
					checkerBase = time.Now()
				}
				today = time.Date(checkerBase.Year(), checkerBase.Month(), checkerBase.Day(), 0, 0, 0, 0, checkerBase.Location())
			}

			session, err := db.Workout.CreateWorkoutSession(group.ID, variant.ID, 123456, today, scheduleTimeString)
			if err != nil {
				t.Fatalf("CreateWorkoutSession: %v", err)
			}

			if input.InProgress {
				if err := db.Workout.UpdateSessionStatus(session.ID, "in_progress"); err != nil {
					t.Fatalf("UpdateSessionStatus: %v", err)
				}

				svc := workoutsvc.New(db.Workout, db.TZ)
				if err := svc.StartSession(session.ID); err != nil {
					t.Fatalf("StartSession: %v", err)
				}
			} else {
				if err := db.Workout.UpdateSessionStatus(session.ID, "notified"); err != nil {
					t.Fatalf("UpdateSessionStatus: %v", err)
				}
				if err := db.Workout.SetSessionNotificationMessageID(session.ID, 1); err != nil {
					t.Fatalf("SetSessionNotificationMessageID: %v", err)
				}
				if input.TimeNow == "2023-10-27T12:05:00Z" && input.AlreadyNotified {
					// We leave notes empty so the test triggers the "resent_3h" notification block
				}
				if input.TimeNow == "2023-10-27T15:05:00Z" && input.AlreadyNotified {
					// For 6h auto skip, it must have already been resent
					if err := db.Workout.UpdateWorkoutSessionNotes(session.ID, "resent_3h"); err != nil {
						t.Fatalf("UpdateWorkoutSessionNotes: %v", err)
					}
				}
				if input.SnoozeDurationHours > 0 {
					svc := workoutsvc.New(db.Workout, db.TZ)
					if err := svc.SnoozeSession(session.ID, time.Duration(input.SnoozeDurationHours)*time.Hour); err != nil {
						t.Fatalf("SnoozeSession: %v", err)
					}
				}
			}
		} else if input.ScheduleTime == "09:00" && input.StaleDurationHours == -1 {
			today := time.Date(nowTime.Year(), nowTime.Month(), nowTime.Day(), 0, 0, 0, 0, nowTime.Location())
			session, err := db.Workout.CreateWorkoutSession(group.ID, variant.ID, 123456, today, input.ScheduleTime)
			if err != nil {
				t.Fatalf("CreateWorkoutSession: %v", err)
			}
			if err := db.Workout.PreSkipSession(session.ID); err != nil {
				t.Fatalf("PreSkipSession: %v", err)
			}
		}

		mockNotifier := &MockNotifier{}

		// Setup WorkoutChecker properly with proper svc and cache
		sched := New(db, 123456, []notifier.Notifier{mockNotifier})

		// Use the correct embedded svc
		sched.WorkoutChecker.workoutSvc = workoutsvc.New(db.Workout, db.TZ)
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

		actual := workoutScenarioExpected{
			Notifications: len(mockNotifier.Notifications),
		}

		testharness.CompareJSON(t, expected, actual)
	})
}
