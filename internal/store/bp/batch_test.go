package bp

import (
	"context"
	"testing"
	"time"
)

func TestBatchGetBPReminderStates(t *testing.T) {
	r := setupBPRepo(t)
	ctx := context.Background()

	userIDs := []int64{1, 2, 3}

	for _, uid := range userIDs {
		_, err := r.GetBPReminderState(uid)
		if err != nil {
			t.Fatalf("Init state failed: %v", err)
		}
	}

	states, err := r.BatchGetBPReminderStates(ctx, userIDs)
	if err != nil {
		t.Fatalf("BatchGetBPReminderStates failed: %v", err)
	}

	if len(states) != 3 {
		t.Fatalf("Expected 3 states, got %d", len(states))
	}
}

func TestBatchGetLastBPReadings(t *testing.T) {
	r := setupBPRepo(t)
	ctx := context.Background()

	userIDs := []int64{1, 2, 3}

	for _, uid := range userIDs {
		// Older reading
		_, err := r.CreateBloodPressureReading(ctx, &BloodPressure{
			UserID:     uid,
			Systolic:   120,
			Diastolic:  80,
			MeasuredAt: time.Now().Add(-2 * time.Hour),
		})
		if err != nil {
			t.Fatalf("Create reading failed: %v", err)
		}

		// Newer reading
		_, err = r.CreateBloodPressureReading(ctx, &BloodPressure{
			UserID:     uid,
			Systolic:   130,
			Diastolic:  90,
			MeasuredAt: time.Now().Add(-1 * time.Hour),
		})
		if err != nil {
			t.Fatalf("Create reading failed: %v", err)
		}
	}

	readings, err := r.BatchGetLastBPReadings(ctx, userIDs)
	if err != nil {
		t.Fatalf("BatchGetLastBPReadings failed: %v", err)
	}

	if len(readings) != 3 {
		t.Fatalf("Expected 3 readings, got %d", len(readings))
	}

	for _, uid := range userIDs {
		reading, ok := readings[uid]
		if !ok {
			t.Fatalf("Missing reading for user %d", uid)
		}
		if reading.Systolic != 130 {
			t.Errorf("Expected systolic 130 for user %d, got %d", uid, reading.Systolic)
		}
	}
}
