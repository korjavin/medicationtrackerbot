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

	if err := db.SetBloodPressureEnabled(context.Background(), true); err != nil {
		b.Fatalf("SetBloodPressureEnabled failed: %v", err)
	}

	// Create 100 users with enabled reminders
	now := time.Now()
	for i := 1; i <= 100; i++ {
		userID := int64(i)
		if err := db.SetBPReminderEnabled(userID, true); err != nil {
			b.Fatalf("SetBPReminderEnabled failed: %v", err)
		}
		// Set preferred hour to current hour so they don't get skipped early
		if err := db.UpdatePreferredReminderHour(userID, now.Hour()); err != nil {
			b.Fatalf("UpdatePreferredReminderHour failed: %v", err)
		}
        // Add some past BP readings to avoid early skip and test DB performance
		for j := 0; j < 5; j++ {
			_, err := db.CreateBloodPressureReading(context.Background(), &store.BloodPressure{
				UserID:     userID,
				Systolic:   120,
				Diastolic:  80,
				MeasuredAt: now.Add(-time.Duration(j*24+24) * time.Hour),
			})
			if err != nil {
				b.Fatalf("CreateBloodPressureReading failed: %v", err)
			}
		}
	}

	mockNotifier := &MockNotifier{}
	sched := New(db, 123456, []notifier.Notifier{mockNotifier})

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		err := sched.BPReminderChecker.Check(context.Background())
		if err != nil {
			b.Fatalf("Check returned error: %v", err)
		}
	}
}
