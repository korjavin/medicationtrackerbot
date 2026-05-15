package scheduler

import (
	"context"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// setupBenchStore is typically in store_bench_test.go but let's just initialize db
func setupBenchStoreForScheduler(b *testing.B) *store.Store {
	db, err := store.New(":memory:")
	if err != nil {
		b.Fatalf("Failed to create memory db: %v", err)
	}
	return db
}

func BenchmarkWeightReminderChecker_Check(b *testing.B) {
	db := setupBenchStoreForScheduler(b)
	defer db.Close()

	if err := db.Settings.SetWeightEnabled(context.Background(), true); err != nil {
		b.Fatalf("SetWeightEnabled failed: %v", err)
	}

	// Create 1000 users with enabled weight reminders and last logs
	now := time.Now()
	for i := 1; i <= 1000; i++ {
		userID := int64(i)
		if err := db.Weight.SetReminderEnabled(userID, true); err != nil {
			b.Fatalf("SetWeightReminderEnabled failed: %v", err)
		}

		// Set it up so it doesn't trigger notification (to avoid hitting the mock notifier constantly)
		// by setting last log to very recent.
		_, err := db.Weight.CreateLog(context.Background(), &store.WeightLog{
			UserID:     userID,
			Weight:     75.0,
			MeasuredAt: now.Add(-1 * time.Hour), // Very recent
		})
		if err != nil {
			b.Fatalf("CreateWeightLog failed: %v", err)
		}
	}

	checker := New(db, 0, []notifier.Notifier{}).WeightReminderChecker

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		err := checker.Check(context.Background())
		if err != nil {
			b.Fatalf("Check failed: %v", err)
		}
	}
}
