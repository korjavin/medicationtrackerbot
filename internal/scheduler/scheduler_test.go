package scheduler

import (
	"context"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func setupTestScheduler(t *testing.T) (*Scheduler, *store.Store) {
	t.Helper()
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	// Create scheduler with no notifiers
	sched := New(db, 123456, nil)
	return sched, db
}

// --- checkSchedule tests ---

func TestCheckSchedule_DisabledFeature(t *testing.T) {
	sched, db := setupTestScheduler(t)

	// Disable medication feature
	if err := db.SetMedicationEnabled(context.Background(), false); err != nil {
		t.Fatalf("SetMedicationEnabled: %v", err)
	}

	// Should return nil without doing anything
	err := sched.checkSchedule()
	if err != nil {
		t.Errorf("checkSchedule with disabled feature: %v", err)
	}
}

func TestCheckSchedule_NoMedications(t *testing.T) {
	sched, _ := setupTestScheduler(t)

	// Medication feature is enabled by default, but no meds exist
	// Should return nil without panicking (no notifications to send)
	err := sched.checkSchedule()
	if err != nil {
		t.Errorf("checkSchedule with no medications: %v", err)
	}
}

func TestCheckSchedule_AsNeededMedicationSkipped(t *testing.T) {
	sched, db := setupTestScheduler(t)

	// Create an as-needed medication
	_, err := db.CreateMedication("Ibuprofen", "400mg", `{"type":"as_needed"}`, nil, nil, "", "")
	if err != nil {
		t.Fatalf("CreateMedication: %v", err)
	}

	// Should not create any intakes for as_needed
	err = sched.checkSchedule()
	if err != nil {
		t.Errorf("checkSchedule: %v", err)
	}

	// Verify no intakes were created
	pending, err := db.GetPendingIntakes()
	if err != nil {
		t.Fatalf("GetPendingIntakes: %v", err)
	}
	if len(pending) != 0 {
		t.Errorf("Expected 0 pending intakes for as_needed med, got %d", len(pending))
	}
}

func TestCheckSchedule_WeeklyNotToday(t *testing.T) {
	sched, db := setupTestScheduler(t)

	// Create a weekly medication for a day that is NOT today
	now := time.Now()
	todayIdx := int(now.Weekday())
	// Pick a day that's not today (there are 7, so pick (today+1)%7)
	otherDay := (todayIdx + 1) % 7

	schedule := `{"type":"weekly","days":[` + intToStr(otherDay) + `],"times":["` + now.Format("15:04") + `"]}`
	_, err := db.CreateMedication("WeeklyMed", "10mg", schedule, nil, nil, "", "")
	if err != nil {
		t.Fatalf("CreateMedication: %v", err)
	}

	err = sched.checkSchedule()
	if err != nil {
		t.Errorf("checkSchedule: %v", err)
	}

	// Should not create intakes since today is not the scheduled day
	pending, err := db.GetPendingIntakes()
	if err != nil {
		t.Fatalf("GetPendingIntakes: %v", err)
	}
	if len(pending) != 0 {
		t.Errorf("Expected 0 pending intakes on wrong day, got %d", len(pending))
	}
}

func TestCheckSchedule_FutureTimeSkipped(t *testing.T) {
	sched, db := setupTestScheduler(t)

	// Create a daily medication scheduled 2 hours from now
	futureTime := time.Now().Add(2 * time.Hour).Format("15:04")
	schedule := `{"type":"daily","times":["` + futureTime + `"]}`
	_, err := db.CreateMedication("FutureMed", "5mg", schedule, nil, nil, "", "")
	if err != nil {
		t.Fatalf("CreateMedication: %v", err)
	}

	err = sched.checkSchedule()
	if err != nil {
		t.Errorf("checkSchedule: %v", err)
	}

	// Should not create intake for future time
	pending, err := db.GetPendingIntakes()
	if err != nil {
		t.Fatalf("GetPendingIntakes: %v", err)
	}
	if len(pending) != 0 {
		t.Errorf("Expected 0 pending intakes for future time, got %d", len(pending))
	}
}

func TestCheckSchedule_StartDateNotYetActive(t *testing.T) {
	sched, db := setupTestScheduler(t)

	// Create a medication with start date in the future
	pastTime := time.Now().Add(-1 * time.Hour).Format("15:04")
	futureStart := time.Now().Add(24 * time.Hour)
	schedule := `{"type":"daily","times":["` + pastTime + `"]}`
	_, err := db.CreateMedication("FutureStartMed", "5mg", schedule, &futureStart, nil, "", "")
	if err != nil {
		t.Fatalf("CreateMedication: %v", err)
	}

	err = sched.checkSchedule()
	if err != nil {
		t.Errorf("checkSchedule: %v", err)
	}

	pending, err := db.GetPendingIntakes()
	if err != nil {
		t.Fatalf("GetPendingIntakes: %v", err)
	}
	if len(pending) != 0 {
		t.Errorf("Expected 0 pending intakes before start date, got %d", len(pending))
	}
}

func TestCheckSchedule_EndDatePassed(t *testing.T) {
	sched, db := setupTestScheduler(t)

	// Create a medication with end date in the past
	pastTime := time.Now().Add(-1 * time.Hour).Format("15:04")
	pastEnd := time.Now().Add(-24 * time.Hour)
	schedule := `{"type":"daily","times":["` + pastTime + `"]}`
	_, err := db.CreateMedication("EndedMed", "5mg", schedule, nil, &pastEnd, "", "")
	if err != nil {
		t.Fatalf("CreateMedication: %v", err)
	}

	err = sched.checkSchedule()
	if err != nil {
		t.Errorf("checkSchedule: %v", err)
	}

	pending, err := db.GetPendingIntakes()
	if err != nil {
		t.Fatalf("GetPendingIntakes: %v", err)
	}
	if len(pending) != 0 {
		t.Errorf("Expected 0 pending intakes after end date, got %d", len(pending))
	}
}

func TestCheckSchedule_ExistingIntakeNotDuplicated(t *testing.T) {
	sched, db := setupTestScheduler(t)

	// Create a daily medication scheduled 1 hour ago
	pastTime := time.Now().Add(-1 * time.Hour)
	timeStr := pastTime.Format("15:04")
	schedule := `{"type":"daily","times":["` + timeStr + `"]}`
	medID, err := db.CreateMedication("DailyMed", "5mg", schedule, nil, nil, "", "")
	if err != nil {
		t.Fatalf("CreateMedication: %v", err)
	}

	// Pre-create an intake at the target time
	now := time.Now()
	target := time.Date(now.Year(), now.Month(), now.Day(),
		pastTime.Hour(), pastTime.Minute(), 0, 0, now.Location())
	_, err = db.CreateIntake(medID, 123456, target)
	if err != nil {
		t.Fatalf("CreateIntake: %v", err)
	}

	// checkSchedule should not create duplicates (bot is nil, so if it tried to
	// send notifications it would panic - the fact it doesn't means it found the existing intake)
	err = sched.checkSchedule()
	if err != nil {
		t.Errorf("checkSchedule: %v", err)
	}
}

// --- checkReminders tests ---

func TestCheckReminders_NoPending(t *testing.T) {
	sched, _ := setupTestScheduler(t)

	err := sched.checkReminders()
	if err != nil {
		t.Errorf("checkReminders with no pending: %v", err)
	}
}

// --- checkLowStock tests ---

func TestCheckLowStock_WrongHour(t *testing.T) {
	sched, _ := setupTestScheduler(t)

	// checkLowStock only runs at hour 11. If current hour isn't 11, it returns immediately.
	now := time.Now()
	if now.Hour() == 11 {
		t.Skip("Skipping: current hour is 11, can't test wrong-hour path")
	}

	// Should return without doing anything (no panic)
	sched.checkLowStock()
}

func TestCheckLowStock_AlreadyCheckedToday(t *testing.T) {
	sched, _ := setupTestScheduler(t)

	// Set lastLowStockCheck to today
	sched.lastLowStockCheck = time.Now()

	// Should not check again today
	sched.checkLowStock()
	// No panic = success
}

// --- checkBPReminders tests ---

func TestCheckBPReminders_DisabledFeature(t *testing.T) {
	sched, db := setupTestScheduler(t)

	if err := db.SetBloodPressureEnabled(context.Background(), false); err != nil {
		t.Fatalf("SetBloodPressureEnabled: %v", err)
	}

	err := sched.checkBPReminders()
	if err != nil {
		t.Errorf("checkBPReminders with disabled feature: %v", err)
	}
}

func TestCheckBPReminders_NoUsers(t *testing.T) {
	sched, _ := setupTestScheduler(t)

	// BP feature is enabled by default, but no users have reminders enabled
	err := sched.checkBPReminders()
	if err != nil {
		t.Errorf("checkBPReminders with no users: %v", err)
	}
}

func TestCheckBPReminders_UserSnoozed(t *testing.T) {
	sched, db := setupTestScheduler(t)
	userID := int64(123456)

	// Enable BP reminders for user
	if err := db.SetBPReminderEnabled(userID, true); err != nil {
		t.Fatalf("SetBPReminderEnabled: %v", err)
	}

	// Snooze (sets snoozed_until to now+2h)
	if err := db.SnoozeBPReminder(userID); err != nil {
		t.Fatalf("SnoozeBPReminder: %v", err)
	}

	// Should skip snoozed users without error
	err := sched.checkBPReminders()
	if err != nil {
		t.Errorf("checkBPReminders with snoozed user: %v", err)
	}
}

func TestCheckBPReminders_AlreadyMeasuredToday(t *testing.T) {
	sched, db := setupTestScheduler(t)
	userID := int64(123456)

	// Enable BP reminders for user
	if err := db.SetBPReminderEnabled(userID, true); err != nil {
		t.Fatalf("SetBPReminderEnabled: %v", err)
	}

	// Create a BP reading from today
	ctx := context.Background()
	_, err := db.CreateBloodPressureReading(ctx, &store.BloodPressure{
		UserID:     userID,
		Systolic:   120,
		Diastolic:  80,
		MeasuredAt: time.Now(),
	})
	if err != nil {
		t.Fatalf("CreateBloodPressureReading: %v", err)
	}

	// Should skip since user already measured today
	err = sched.checkBPReminders()
	if err != nil {
		t.Errorf("checkBPReminders with today's reading: %v", err)
	}
}

func TestCheckBPReminders_DontRemindUntilActive(t *testing.T) {
	sched, db := setupTestScheduler(t)
	userID := int64(123456)

	// Enable BP reminders for user
	if err := db.SetBPReminderEnabled(userID, true); err != nil {
		t.Fatalf("SetBPReminderEnabled: %v", err)
	}

	// Set "don't remind until" (sets dont_remind_until to now+24h)
	if err := db.DontBugMeBPReminder(userID); err != nil {
		t.Fatalf("DontBugMeBPReminder: %v", err)
	}

	err := sched.checkBPReminders()
	if err != nil {
		t.Errorf("checkBPReminders with dont_remind_until: %v", err)
	}
}

// --- checkWeightReminders tests ---

func TestCheckWeightReminders_DisabledFeature(t *testing.T) {
	sched, db := setupTestScheduler(t)

	if err := db.SetWeightEnabled(context.Background(), false); err != nil {
		t.Fatalf("SetWeightEnabled: %v", err)
	}

	err := sched.checkWeightReminders()
	if err != nil {
		t.Errorf("checkWeightReminders with disabled feature: %v", err)
	}
}

func TestCheckWeightReminders_NoUsers(t *testing.T) {
	sched, _ := setupTestScheduler(t)

	err := sched.checkWeightReminders()
	if err != nil {
		t.Errorf("checkWeightReminders with no users: %v", err)
	}
}

func TestCheckWeightReminders_UserSnoozed(t *testing.T) {
	sched, db := setupTestScheduler(t)
	userID := int64(123456)

	if err := db.SetWeightReminderEnabled(userID, true); err != nil {
		t.Fatalf("SetWeightReminderEnabled: %v", err)
	}

	if err := db.SnoozeWeightReminder(userID); err != nil {
		t.Fatalf("SnoozeWeightReminder: %v", err)
	}

	err := sched.checkWeightReminders()
	if err != nil {
		t.Errorf("checkWeightReminders with snoozed user: %v", err)
	}
}

func TestCheckWeightReminders_RecentMeasurement(t *testing.T) {
	sched, db := setupTestScheduler(t)
	userID := int64(123456)

	if err := db.SetWeightReminderEnabled(userID, true); err != nil {
		t.Fatalf("SetWeightReminderEnabled: %v", err)
	}

	// Create a weight log from today
	ctx := context.Background()
	_, err := db.CreateWeightLog(ctx, &store.WeightLog{
		UserID:     userID,
		Weight:     75.0,
		MeasuredAt: time.Now(),
	})
	if err != nil {
		t.Fatalf("CreateWeightLog: %v", err)
	}

	// Should skip since user measured recently (within 7 days)
	err = sched.checkWeightReminders()
	if err != nil {
		t.Errorf("checkWeightReminders with recent measurement: %v", err)
	}
}

func TestCheckWeightReminders_DontRemindUntilActive(t *testing.T) {
	sched, db := setupTestScheduler(t)
	userID := int64(123456)

	if err := db.SetWeightReminderEnabled(userID, true); err != nil {
		t.Fatalf("SetWeightReminderEnabled: %v", err)
	}

	if err := db.DontBugMeWeightReminder(userID); err != nil {
		t.Fatalf("DontBugMeWeightReminder: %v", err)
	}

	err := sched.checkWeightReminders()
	if err != nil {
		t.Errorf("checkWeightReminders with dont_remind_until: %v", err)
	}
}

// --- checkWorkoutNotifications tests ---

func TestCheckWorkoutNotifications_DisabledFeature(t *testing.T) {
	sched, db := setupTestScheduler(t)

	if err := db.SetWorkoutEnabled(context.Background(), false); err != nil {
		t.Fatalf("SetWorkoutEnabled: %v", err)
	}

	err := sched.checkWorkoutNotifications()
	if err != nil {
		t.Errorf("checkWorkoutNotifications with disabled feature: %v", err)
	}
}

func TestCheckWorkoutNotifications_NoGroups(t *testing.T) {
	sched, _ := setupTestScheduler(t)

	// Workout feature enabled by default, no groups exist
	err := sched.checkWorkoutNotifications()
	if err != nil {
		t.Errorf("checkWorkoutNotifications with no groups: %v", err)
	}
}

func TestCheckWorkoutNotifications_WrongDay(t *testing.T) {
	sched, db := setupTestScheduler(t)

	// Create a workout group scheduled for a day that's not today
	now := time.Now()
	todayIdx := int(now.Weekday())
	otherDay := (todayIdx + 1) % 7

	daysOfWeek := "[" + intToStr(otherDay) + "]"
	_, err := db.CreateWorkoutGroup("TestGroup", "desc", false, 123456, daysOfWeek, "09:00", 15)
	if err != nil {
		t.Fatalf("CreateWorkoutGroup: %v", err)
	}

	err = sched.checkWorkoutNotifications()
	if err != nil {
		t.Errorf("checkWorkoutNotifications on wrong day: %v", err)
	}
}

func TestCheckWorkoutNotifications_SessionCreatedOnScheduledDay(t *testing.T) {
	sched, db := setupTestScheduler(t)

	// Create a workout group scheduled for today, but with future scheduled time
	// so no notification is sent (avoids bot nil panic)
	now := time.Now()
	todayIdx := int(now.Weekday())
	daysOfWeek := "[" + intToStr(todayIdx) + "]"

	// Set scheduled time to 2 hours from now to avoid notification trigger
	futureTime := now.Add(2 * time.Hour).Format("15:04")

	group, err := db.CreateWorkoutGroup("TodayGroup", "desc", false, 123456, daysOfWeek, futureTime, 15)
	if err != nil {
		t.Fatalf("CreateWorkoutGroup: %v", err)
	}

	// Create a variant for the group (required for session creation)
	order := 0
	_, err = db.CreateWorkoutVariant(group.ID, "Variant A", &order, "")
	if err != nil {
		t.Fatalf("CreateWorkoutVariant: %v", err)
	}

	err = sched.checkWorkoutNotifications()
	if err != nil {
		t.Errorf("checkWorkoutNotifications: %v", err)
	}

	// Should have created a session for today
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	session, err := db.GetSessionByGroupAndDate(group.ID, today)
	if err != nil {
		t.Fatalf("GetSessionByGroupAndDate: %v", err)
	}
	if session == nil {
		t.Error("Expected session to be created for today")
	} else if session.Status != "pending" {
		t.Errorf("Expected session status 'pending', got %q", session.Status)
	}
}

func TestCheckWorkoutNotifications_PreSkippedSession(t *testing.T) {
	sched, db := setupTestScheduler(t)

	now := time.Now()
	todayIdx := int(now.Weekday())
	daysOfWeek := "[" + intToStr(todayIdx) + "]"

	// Set scheduled time to 1 hour ago so the pre_skipped → skipped logic triggers
	pastTime := now.Add(-1 * time.Hour).Format("15:04")

	group, err := db.CreateWorkoutGroup("SkipGroup", "desc", false, 123456, daysOfWeek, pastTime, 15)
	if err != nil {
		t.Fatalf("CreateWorkoutGroup: %v", err)
	}

	order := 0
	variant, err := db.CreateWorkoutVariant(group.ID, "Variant A", &order, "")
	if err != nil {
		t.Fatalf("CreateWorkoutVariant: %v", err)
	}

	// Create a session and pre-skip it
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	session, err := db.CreateWorkoutSession(group.ID, variant.ID, 123456, today, pastTime)
	if err != nil {
		t.Fatalf("CreateWorkoutSession: %v", err)
	}
	if err := db.PreSkipSession(session.ID); err != nil {
		t.Fatalf("PreSkipSession: %v", err)
	}

	err = sched.checkWorkoutNotifications()
	if err != nil {
		t.Errorf("checkWorkoutNotifications: %v", err)
	}

	// Session should now be skipped (auto-skipped from pre_skipped after scheduled time)
	updated, err := db.GetWorkoutSession(session.ID)
	if err != nil {
		t.Fatalf("GetWorkoutSession: %v", err)
	}
	if updated.Status != "skipped" {
		t.Errorf("Expected pre_skipped session to become 'skipped', got %q", updated.Status)
	}
}

// --- Helper functions ---

func intToStr(i int) string {
	return []string{"0", "1", "2", "3", "4", "5", "6"}[i]
}
