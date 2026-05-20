//go:build !mobile

package scheduler

import (
	"context"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// TestBPReminderChecker_UsesUserTimezone verifies that the BP checker uses the stored
// user timezone when determining the current hour for scheduling decisions.
//
// Setup: preferred hour = 16, user TZ = America/New_York (UTC-5).
// nowTime = 2024-01-15T21:30:00Z → 16:30 in New York → within [preferredHour-1, preferredHour+1].
// Without TZ support currentHour=21 > 17, no notification.
// With TZ support currentHour=16, notification fires.
func TestBPReminderChecker_UsesUserTimezone(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	if err := db.Settings.SetBloodPressureEnabled(context.Background(), true); err != nil {
		t.Fatalf("SetBloodPressureEnabled: %v", err)
	}

	userID := int64(123456)
	if err := db.BP.SetReminderEnabled(userID, true); err != nil {
		t.Fatalf("SetReminderEnabled: %v", err)
	}

	// Record a user timezone of America/New_York (UTC-5).
	if err := db.TZ.Record("America/New_York"); err != nil {
		t.Fatalf("Record: %v", err)
	}

	// 2024-01-15T21:30:00Z = 2024-01-15T16:30:00-05:00 in New York.
	nowTime := time.Date(2024, 1, 15, 21, 30, 0, 0, time.UTC)

	// Add an old BP reading (yesterday) so the "already measured today" guard does not block.
	_, err = db.BP.CreateReading(context.Background(), &store.BloodPressure{
		UserID:     userID,
		Systolic:   120,
		Diastolic:  80,
		MeasuredAt: nowTime.Add(-24 * time.Hour),
	})
	if err != nil {
		t.Fatalf("CreateReading: %v", err)
	}

	// Set preferred hour to 16 (matches New York hour, not UTC hour 21).
	if err := db.BP.UpdatePreferredReminderHour(userID, 16); err != nil {
		t.Fatalf("UpdatePreferredReminderHour: %v", err)
	}

	mock := &mockNotifier{sendMsgID: 1}
	sched := NewWithNotifiers(db, 123456, []notifier.Notifier{mock})
	sched.BPReminderChecker.now = func() time.Time { return nowTime }

	if err := sched.BPReminderChecker.Check(context.Background()); err != nil {
		t.Fatalf("Check: %v", err)
	}

	calls := mock.getSendCalls()
	if len(calls) != 1 {
		t.Errorf("expected 1 notification (user TZ used), got %d", len(calls))
	}
}

// TestBPReminderChecker_NoNotificationInWrongUserTZHour verifies that when the UTC clock
// matches the preferred hour but the user's stored TZ maps to a different hour, no
// notification is sent.
//
// Setup: preferred hour = 21 (UTC hour), user TZ = America/New_York (UTC-5).
// nowTime = 2024-01-15T21:30:00Z → 16:30 in New York → outside [21-1, 21+1].
// Expected: no notification because the checker evaluates hours in New York TZ.
func TestBPReminderChecker_NoNotificationInWrongUserTZHour(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	if err := db.Settings.SetBloodPressureEnabled(context.Background(), true); err != nil {
		t.Fatalf("SetBloodPressureEnabled: %v", err)
	}

	userID := int64(123456)
	if err := db.BP.SetReminderEnabled(userID, true); err != nil {
		t.Fatalf("SetReminderEnabled: %v", err)
	}

	if err := db.TZ.Record("America/New_York"); err != nil {
		t.Fatalf("Record: %v", err)
	}

	nowTime := time.Date(2024, 1, 15, 21, 30, 0, 0, time.UTC)

	_, err = db.BP.CreateReading(context.Background(), &store.BloodPressure{
		UserID:     userID,
		Systolic:   120,
		Diastolic:  80,
		MeasuredAt: nowTime.Add(-24 * time.Hour),
	})
	if err != nil {
		t.Fatalf("CreateReading: %v", err)
	}

	// Preferred hour = 21 (UTC hour), but in New York it's 16 — does not match.
	if err := db.BP.UpdatePreferredReminderHour(userID, 21); err != nil {
		t.Fatalf("UpdatePreferredReminderHour: %v", err)
	}

	mock := &mockNotifier{sendMsgID: 1}
	sched := NewWithNotifiers(db, 123456, []notifier.Notifier{mock})
	sched.BPReminderChecker.now = func() time.Time { return nowTime }

	if err := sched.BPReminderChecker.Check(context.Background()); err != nil {
		t.Fatalf("Check: %v", err)
	}

	calls := mock.getSendCalls()
	if len(calls) != 0 {
		t.Errorf("expected 0 notifications (user TZ mismatch), got %d", len(calls))
	}
}

// TestWeightReminderChecker_UsesUserTimezone verifies that the weight checker uses the stored
// user timezone when comparing current hour to the preferred reminder hour.
func TestWeightReminderChecker_UsesUserTimezone(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	if err := db.Settings.SetWeightEnabled(context.Background(), true); err != nil {
		t.Fatalf("SetWeightEnabled: %v", err)
	}

	userID := int64(123456)
	if err := db.Weight.SetReminderEnabled(userID, true); err != nil {
		t.Fatalf("SetWeightReminderEnabled: %v", err)
	}

	if err := db.TZ.Record("America/New_York"); err != nil {
		t.Fatalf("Record: %v", err)
	}

	// 2024-01-15T14:00:00Z = 2024-01-15T09:00:00-05:00 in New York.
	nowTime := time.Date(2024, 1, 15, 14, 0, 0, 0, time.UTC)

	// Old weight log (>7 days ago) so reminder fires.
	_, err = db.Weight.CreateLog(context.Background(), &store.WeightLog{
		UserID:     userID,
		Weight:     75.0,
		MeasuredAt: nowTime.Add(-8 * 24 * time.Hour),
	})
	if err != nil {
		t.Fatalf("CreateWeightLog: %v", err)
	}

	// Preferred hour = 9 (matches New York hour, not UTC hour 14).
	if err := db.Weight.UpdatePreferredReminderHour(userID, 9); err != nil {
		t.Fatalf("UpdatePreferredWeightReminderHour: %v", err)
	}

	mock := &mockNotifier{sendMsgID: 1}
	sched := NewWithNotifiers(db, 123456, []notifier.Notifier{mock})
	sched.WeightReminderChecker.now = func() time.Time { return nowTime }

	if err := sched.WeightReminderChecker.Check(context.Background()); err != nil {
		t.Fatalf("Check: %v", err)
	}

	calls := mock.getSendCalls()
	if len(calls) != 1 {
		t.Errorf("expected 1 notification (user TZ used), got %d", len(calls))
	}
}

// TestWorkoutChecker_UsesUserTimezoneForWeekday verifies that the workout checker uses the
// stored user timezone when determining today's weekday. A UTC time that crosses midnight
// in the user's timezone should use the user's local date, not the UTC date.
func TestWorkoutChecker_UsesUserTimezoneForWeekday(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	if err := db.Settings.SetWorkoutEnabled(context.Background(), true); err != nil {
		t.Fatalf("SetWorkoutEnabled: %v", err)
	}

	if err := db.TZ.Record("America/New_York"); err != nil {
		t.Fatalf("Record: %v", err)
	}

	// 2024-01-16T02:00:00Z = 2024-01-15T21:00:00-05:00 in New York.
	// UTC weekday: Tuesday (index 2). New York weekday: Monday (index 1).
	nowTime := time.Date(2024, 1, 16, 2, 0, 0, 0, time.UTC)

	nyLoc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatalf("LoadLocation: %v", err)
	}
	nowInNY := nowTime.In(nyLoc)
	nyWeekday := int(nowInNY.Weekday()) // Monday = 1

	// Schedule a group on the New York weekday only.
	daysOfWeek := "[" + intToStr(nyWeekday) + "]"
	group, err := db.Workout.CreateGroup("TZGroup", "desc", false, 123456, daysOfWeek, "20:00", 15)
	if err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}

	order := 0
	_, err = db.Workout.CreateVariant(group.ID, "Variant A", &order, "")
	if err != nil {
		t.Fatalf("CreateVariant: %v", err)
	}

	mock := &mockNotifier{sendMsgID: 1}
	sched := NewWithNotifiers(db, 123456, []notifier.Notifier{mock})
	sched.WorkoutChecker.now = func() time.Time { return nowTime }

	if err := sched.WorkoutChecker.Check(context.Background()); err != nil {
		t.Fatalf("Check: %v", err)
	}

	// Verify a session was created for the New York date.
	nyToday := time.Date(nowInNY.Year(), nowInNY.Month(), nowInNY.Day(), 0, 0, 0, 0, nyLoc)
	session, err := db.Workout.GetSessionByGroupAndDate(group.ID, nyToday)
	if err != nil {
		t.Fatalf("GetSessionByGroupAndDate: %v", err)
	}
	if session == nil {
		t.Error("expected session to be created for New York date (Monday), but got nil")
	}
}

// TestBPReminderChecker_FallsBackToSystemTZOnInvalidTimezone verifies that an invalid
// stored timezone does not cause a crash — the checker falls back gracefully.
func TestBPReminderChecker_FallsBackToSystemTZOnInvalidTimezone(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	if err := db.Settings.SetBloodPressureEnabled(context.Background(), true); err != nil {
		t.Fatalf("SetBloodPressureEnabled: %v", err)
	}

	if err := db.TZ.Record("Not/A/Real/Timezone"); err != nil {
		t.Fatalf("Record: %v", err)
	}

	sched := NewWithNotifiers(db, 123456, nil)
	// Should not panic or return an error — just logs a warning and uses system TZ.
	if err := sched.BPReminderChecker.Check(context.Background()); err != nil {
		t.Fatalf("Check returned unexpected error: %v", err)
	}
}
