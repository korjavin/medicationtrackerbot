package scheduler

import (
	"context"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func BenchmarkBPReminderChecker(b *testing.B) {
	db, err := store.New(":memory:")
	if err != nil {
		b.Fatalf("Failed to create memory db: %v", err)
	}
	defer db.Close()

	ctx := context.Background()
	if err := db.Settings.SetBloodPressureEnabled(ctx, true); err != nil {
		b.Fatalf("Failed to enable BP: %v", err)
	}

	// Create 500 users with enabled reminders and a reading
	numUsers := 500
	now := time.Now()
	for i := 1; i <= numUsers; i++ {
		userID := int64(i)
		if err := db.BP.SetReminderEnabled(userID, true); err != nil {
			b.Fatalf("Failed to enable reminder for user %d: %v", userID, err)
		}

		// Set some state so they don't immediately trigger a notification
		// Just want to benchmark the loop logic, not sending notifications
		if err := db.BP.UpdatePreferredReminderHour(userID, 20); err != nil {
			b.Fatalf("Failed to set preferred hour: %v", err)
		}

		// Insert a recent reading
		_, err := db.BP.CreateReading(ctx, &store.BloodPressure{
			UserID:     userID,
			Systolic:   120,
			Diastolic:  80,
			MeasuredAt: now.Add(-1 * time.Hour), // 1 hour ago
		})
		if err != nil {
			b.Fatalf("Failed to insert reading: %v", err)
		}
	}

	mockNotifier := &MockNotifier{}
	sched := New(db, 1, []notifier.Notifier{mockNotifier})

	// Set the current time so that preferred hour matches or doesn't match
	// Let's make it match so it goes deeper, but recent reading prevents notification
	sched.BPReminderChecker.now = func() time.Time {
		// Set to 8 PM
		return time.Date(now.Year(), now.Month(), now.Day(), 20, 0, 0, 0, now.Location())
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		err := sched.BPReminderChecker.Check(ctx)
		if err != nil {
			b.Fatalf("Check failed: %v", err)
		}
	}
}
