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
)

type bpScenarioInput struct {
	TimeNow       string `json:"time_now"`
	Snoozed       bool   `json:"snoozed"`
	DontBugMe     bool   `json:"dont_bug_me"`
	ReadingsToday int    `json:"readings_today"`
	NotifiedToday bool   `json:"notified_today"`
}

type bpScenarioExpected struct {
	Notifications int `json:"notifications"`
}

func TestBPReminderCheckerScenarios(t *testing.T) {
	filename := filepath.Join("testdata", "bp_reminder_scenarios.json")

	testharness.RunScenarios(t, filename, func(t *testing.T, s testharness.Scenario) {
		var input bpScenarioInput
		if err := json.Unmarshal(s.Input, &input); err != nil {
			t.Fatalf("Failed to unmarshal input: %v", err)
		}

		var expected bpScenarioExpected
		if err := json.Unmarshal(s.Expected, &expected); err != nil {
			t.Fatalf("Failed to unmarshal expected: %v", err)
		}

		db, err := store.New(":memory:")
		if err != nil {
			t.Fatalf("Failed to create memory db: %v", err)
		}
		defer db.Close() // #nosec G104

		if err := db.Settings.SetBloodPressureEnabled(context.Background(), true); err != nil {
			t.Fatalf("SetBloodPressureEnabled failed: %v", err)
		}

		userID := int64(123456)
		if err := db.BP.SetReminderEnabled(userID, true); err != nil {
			t.Fatalf("SetReminderEnabled failed: %v", err)
		}

		nowTime, err := time.Parse(time.RFC3339, input.TimeNow)
		if err != nil {
			t.Fatalf("Failed to parse TimeNow: %v", err)
		}

		// Configure state
		if input.Snoozed {
			if err := db.BP.SnoozeReminder(userID); err != nil {
				t.Fatalf("SnoozeReminder failed: %v", err)
			}
		}

		if input.DontBugMe {
			if err := db.BP.DontBugMeReminder(userID); err != nil {
				t.Fatalf("DontBugMeReminder failed: %v", err)
			}
		}

		if input.NotifiedToday {
			msgID := 123
			if err := db.BP.UpdateReminderNotificationSent(userID, &msgID); err != nil {
				t.Fatalf("UpdateReminderNotificationSent failed: %v", err)
			}
		}

		if input.ReadingsToday > 0 {
			for i := 0; i < input.ReadingsToday; i++ {
				_, err := db.BP.CreateReading(context.Background(), &store.BloodPressure{
					UserID:     userID,
					Systolic:   120,
					Diastolic:  80,
					MeasuredAt: nowTime.Add(-1 * time.Hour), // Ensure it's considered "today"
				})
				if err != nil {
					t.Fatalf("CreateReading failed: %v", err)
				}
			}
		} else {
			// Older reading to ensure category severity logic can run
			_, err := db.BP.CreateReading(context.Background(), &store.BloodPressure{
				UserID:     userID,
				Systolic:   120,
				Diastolic:  80,
				MeasuredAt: nowTime.Add(-24 * time.Hour),
			})
			if err != nil {
				t.Fatalf("CreateReading failed: %v", err)
			}
		}

		mockNotifier := &MockNotifier{}
		sched := New(db, 123456, []notifier.Notifier{mockNotifier})

		sched.BPReminderChecker.now = func() time.Time {
			return nowTime
		}

		if err := db.BP.UpdatePreferredReminderHour(userID, nowTime.Hour()); err != nil {
			t.Fatalf("UpdatePreferredReminderHour failed: %v", err)
		}

		err = sched.BPReminderChecker.Check(context.Background())
		if err != nil {
			t.Errorf("Check returned error: %v", err)
		}

		time.Sleep(10 * time.Millisecond)

		actual := bpScenarioExpected{
			Notifications: len(mockNotifier.snapshotNotifications()),
		}

		testharness.CompareJSON(t, expected, actual)
	})
}
