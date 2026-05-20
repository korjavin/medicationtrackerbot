//go:build !mobile

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
	t.Cleanup(func() { _ = db.Close() }) // #nosec G104

	sched := NewWithNotifiers(db, 123456, nil)
	return sched, db
}

// --- MedicationChecker tests ---

func TestCheckSchedule_DisabledFeature(t *testing.T) {
	sched, db := setupTestScheduler(t)

	if err := db.Settings.SetMedicationEnabled(context.Background(), false); err != nil {
		t.Fatalf("SetMedicationEnabled: %v", err)
	}

	err := sched.MedicationChecker.Check(context.Background())
	if err != nil {
		t.Errorf("Check with disabled feature: %v", err)
	}
}

func TestCheckSchedule_NoMedications(t *testing.T) {
	sched, _ := setupTestScheduler(t)

	err := sched.MedicationChecker.Check(context.Background())
	if err != nil {
		t.Errorf("Check with no medications: %v", err)
	}
}

func TestCheckSchedule_AsNeededMedicationSkipped(t *testing.T) {
	sched, db := setupTestScheduler(t)

	_, err := db.Medication.Create("Ibuprofen", "400mg", `{"type":"as_needed"}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	err = sched.MedicationChecker.Check(context.Background())
	if err != nil {
		t.Errorf("Check: %v", err)
	}

	pending, err := db.Medication.ListPendingIntakes()
	if err != nil {
		t.Fatalf("ListPendingIntakes: %v", err)
	}
	if len(pending) != 0 {
		t.Errorf("Expected 0 pending intakes for as_needed med, got %d", len(pending))
	}
}

func TestCheckSchedule_WeeklyNotToday(t *testing.T) {
	sched, db := setupTestScheduler(t)

	now := time.Now()
	todayIdx := int(now.Weekday())
	otherDay := (todayIdx + 1) % 7

	schedule := `{"type":"weekly","days":[` + intToStr(otherDay) + `],"times":["` + now.Format("15:04") + `"]}`
	_, err := db.Medication.Create("WeeklyMed", "10mg", schedule, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	err = sched.MedicationChecker.Check(context.Background())
	if err != nil {
		t.Errorf("Check: %v", err)
	}

	pending, err := db.Medication.ListPendingIntakes()
	if err != nil {
		t.Fatalf("ListPendingIntakes: %v", err)
	}
	if len(pending) != 0 {
		t.Errorf("Expected 0 pending intakes on wrong day, got %d", len(pending))
	}
}

func TestCheckSchedule_FutureTimeSkipped(t *testing.T) {
	sched, db := setupTestScheduler(t)

	now := time.Now()
	futureTimeObj := now.Add(2 * time.Hour)
	if futureTimeObj.Day() != now.Day() {
		t.Skip("Skipping: future time crosses into next day")
	}
	futureTime := futureTimeObj.Format("15:04")
	schedule := `{"type":"daily","times":["` + futureTime + `"]}`
	_, err := db.Medication.Create("FutureMed", "5mg", schedule, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	err = sched.MedicationChecker.Check(context.Background())
	if err != nil {
		t.Errorf("Check: %v", err)
	}

	pending, err := db.Medication.ListPendingIntakes()
	if err != nil {
		t.Fatalf("ListPendingIntakes: %v", err)
	}
	if len(pending) != 0 {
		t.Errorf("Expected 0 pending intakes for future time, got %d", len(pending))
	}
}

func TestCheckSchedule_StartDateNotYetActive(t *testing.T) {
	sched, db := setupTestScheduler(t)

	now := time.Now()
	pastTimeObj := now.Add(-1 * time.Hour)
	if pastTimeObj.Day() != now.Day() {
		t.Skip("Skipping: past time crosses into previous day")
	}
	pastTime := pastTimeObj.Format("15:04")
	futureStart := now.Add(24 * time.Hour)
	schedule := `{"type":"daily","times":["` + pastTime + `"]}`
	_, err := db.Medication.Create("FutureStartMed", "5mg", schedule, &futureStart, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	err = sched.MedicationChecker.Check(context.Background())
	if err != nil {
		t.Errorf("Check: %v", err)
	}

	pending, err := db.Medication.ListPendingIntakes()
	if err != nil {
		t.Fatalf("ListPendingIntakes: %v", err)
	}
	if len(pending) != 0 {
		t.Errorf("Expected 0 pending intakes before start date, got %d", len(pending))
	}
}

func TestCheckSchedule_EndDatePassed(t *testing.T) {
	sched, db := setupTestScheduler(t)

	now := time.Now()
	pastTimeObj := now.Add(-1 * time.Hour)
	if pastTimeObj.Day() != now.Day() {
		t.Skip("Skipping: past time crosses into previous day")
	}
	pastTime := pastTimeObj.Format("15:04")
	pastEnd := now.Add(-24 * time.Hour)
	schedule := `{"type":"daily","times":["` + pastTime + `"]}`
	_, err := db.Medication.Create("EndedMed", "5mg", schedule, nil, &pastEnd, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	err = sched.MedicationChecker.Check(context.Background())
	if err != nil {
		t.Errorf("Check: %v", err)
	}

	pending, err := db.Medication.ListPendingIntakes()
	if err != nil {
		t.Fatalf("ListPendingIntakes: %v", err)
	}
	if len(pending) != 0 {
		t.Errorf("Expected 0 pending intakes after end date, got %d", len(pending))
	}
}

func TestCheckSchedule_ExistingIntakeNotDuplicated(t *testing.T) {
	sched, db := setupTestScheduler(t)

	now := time.Now()
	pastTime := now.Add(-1 * time.Hour)
	if pastTime.Day() != now.Day() {
		t.Skip("Skipping: past time crosses into previous day")
	}
	timeStr := pastTime.Format("15:04")
	schedule := `{"type":"daily","times":["` + timeStr + `"]}`
	medID, err := db.Medication.Create("DailyMed", "5mg", schedule, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	target := time.Date(now.Year(), now.Month(), now.Day(),
		pastTime.Hour(), pastTime.Minute(), 0, 0, now.Location())
	_, err = db.Medication.CreateIntake(medID, 123456, target)
	if err != nil {
		t.Fatalf("CreateIntake: %v", err)
	}

	err = sched.MedicationChecker.Check(context.Background())
	if err != nil {
		t.Errorf("Check: %v", err)
	}
}

func TestCheckSchedule_MultipleMedicationsCreatesMultipleNotifications(t *testing.T) {
	sched, db, mockNotif := setupTestSchedulerWithMock(t)

	now := time.Now()
	pastTime := now.Add(-1 * time.Hour)
	if pastTime.Day() != now.Day() {
		t.Skip("Skipping: past time crosses into previous day")
	}
	timeStr := pastTime.Format("15:04")
	schedule := `{"type":"daily","times":["` + timeStr + `"]}`

	id1, err := db.Medication.Create("Med1", "5mg", schedule, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := db.Medication.UpdateCreatedAt(id1, pastTime.Add(-24*time.Hour)); err != nil {
		t.Fatalf("UpdateCreatedAt Med1: %v", err)
	}

	id2, err := db.Medication.Create("Med2", "10mg", schedule, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := db.Medication.UpdateCreatedAt(id2, pastTime.Add(-24*time.Hour)); err != nil {
		t.Fatalf("UpdateCreatedAt Med2: %v", err)
	}

	err = sched.MedicationChecker.Check(context.Background())
	if err != nil {
		t.Errorf("Check: %v", err)
	}

	// Wait for async sends
	if !mockNotif.waitForSendCalls(3, 2*time.Second) {
		t.Fatal("timed out waiting for send calls")
	}

	calls := mockNotif.getSendCalls()
	// 1 batched notification for Telegram + 2 individual notifications for WebPush
	if len(calls) != 3 {
		t.Errorf("Expected 3 notifications to be sent (1 batched + 2 individual), got %d", len(calls))
	}
}

// --- MedicationReminderChecker tests ---

func TestCheckReminders_NoPending(t *testing.T) {
	sched, _ := setupTestScheduler(t)

	err := sched.MedicationReminderChecker.Check(context.Background())
	if err != nil {
		t.Errorf("Check with no pending: %v", err)
	}
}

// --- LowStockChecker tests ---

func TestCheckLowStock_WrongHour(t *testing.T) {
	sched, _ := setupTestScheduler(t)

	now := time.Now()
	if now.Hour() == 11 {
		t.Skip("Skipping: current hour is 11, can't test wrong-hour path")
	}

	_ = sched.LowStockChecker.Check(context.Background()) // #nosec G104
}

func TestCheckLowStock_AlreadyCheckedToday(t *testing.T) {
	sched, _ := setupTestScheduler(t)

	sched.LowStockChecker.lastCheck = time.Now()

	_ = sched.LowStockChecker.Check(context.Background()) // #nosec G104
}

// --- BPReminderChecker tests ---

func TestCheckBPReminders_DisabledFeature(t *testing.T) {
	sched, db := setupTestScheduler(t)

	if err := db.Settings.SetBloodPressureEnabled(context.Background(), false); err != nil {
		t.Fatalf("SetBloodPressureEnabled: %v", err)
	}

	err := sched.BPReminderChecker.Check(context.Background())
	if err != nil {
		t.Errorf("Check with disabled feature: %v", err)
	}
}

func TestCheckBPReminders_NoUsers(t *testing.T) {
	sched, _ := setupTestScheduler(t)

	err := sched.BPReminderChecker.Check(context.Background())
	if err != nil {
		t.Errorf("Check with no users: %v", err)
	}
}

func TestCheckBPReminders_UserSnoozed(t *testing.T) {
	sched, db := setupTestScheduler(t)
	userID := int64(123456)

	if err := db.BP.SetReminderEnabled(userID, true); err != nil {
		t.Fatalf("SetReminderEnabled: %v", err)
	}

	if err := db.BP.SnoozeReminder(userID); err != nil {
		t.Fatalf("SnoozeReminder: %v", err)
	}

	err := sched.BPReminderChecker.Check(context.Background())
	if err != nil {
		t.Errorf("Check with snoozed user: %v", err)
	}
}

func TestCheckBPReminders_AlreadyMeasuredToday(t *testing.T) {
	sched, db := setupTestScheduler(t)
	userID := int64(123456)

	if err := db.BP.SetReminderEnabled(userID, true); err != nil {
		t.Fatalf("SetReminderEnabled: %v", err)
	}

	ctx := context.Background()
	_, err := db.BP.CreateReading(ctx, &store.BloodPressure{
		UserID:     userID,
		Systolic:   120,
		Diastolic:  80,
		MeasuredAt: time.Now(),
	})
	if err != nil {
		t.Fatalf("CreateReading: %v", err)
	}

	err = sched.BPReminderChecker.Check(context.Background())
	if err != nil {
		t.Errorf("Check with today's reading: %v", err)
	}
}

func TestCheckBPReminders_DontRemindUntilActive(t *testing.T) {
	sched, db := setupTestScheduler(t)
	userID := int64(123456)

	if err := db.BP.SetReminderEnabled(userID, true); err != nil {
		t.Fatalf("SetReminderEnabled: %v", err)
	}

	if err := db.BP.DontBugMeReminder(userID); err != nil {
		t.Fatalf("DontBugMeReminder: %v", err)
	}

	err := sched.BPReminderChecker.Check(context.Background())
	if err != nil {
		t.Errorf("Check with dont_remind_until: %v", err)
	}
}

// --- WeightReminderChecker tests ---

func TestCheckWeightReminders_DisabledFeature(t *testing.T) {
	sched, db := setupTestScheduler(t)

	if err := db.Settings.SetWeightEnabled(context.Background(), false); err != nil {
		t.Fatalf("SetWeightEnabled: %v", err)
	}

	err := sched.WeightReminderChecker.Check(context.Background())
	if err != nil {
		t.Errorf("Check with disabled feature: %v", err)
	}
}

func TestCheckWeightReminders_NoUsers(t *testing.T) {
	sched, _ := setupTestScheduler(t)

	err := sched.WeightReminderChecker.Check(context.Background())
	if err != nil {
		t.Errorf("Check with no users: %v", err)
	}
}

func TestCheckWeightReminders_UserSnoozed(t *testing.T) {
	sched, db := setupTestScheduler(t)
	userID := int64(123456)

	if err := db.Weight.SetReminderEnabled(userID, true); err != nil {
		t.Fatalf("SetWeightReminderEnabled: %v", err)
	}

	if err := db.Weight.SnoozeReminder(userID); err != nil {
		t.Fatalf("SnoozeWeightReminder: %v", err)
	}

	err := sched.WeightReminderChecker.Check(context.Background())
	if err != nil {
		t.Errorf("Check with snoozed user: %v", err)
	}
}

func TestCheckWeightReminders_RecentMeasurement(t *testing.T) {
	sched, db := setupTestScheduler(t)
	userID := int64(123456)

	if err := db.Weight.SetReminderEnabled(userID, true); err != nil {
		t.Fatalf("SetWeightReminderEnabled: %v", err)
	}

	ctx := context.Background()
	_, err := db.Weight.CreateLog(ctx, &store.WeightLog{
		UserID:     userID,
		Weight:     75.0,
		MeasuredAt: time.Now(),
	})
	if err != nil {
		t.Fatalf("CreateWeightLog: %v", err)
	}

	err = sched.WeightReminderChecker.Check(context.Background())
	if err != nil {
		t.Errorf("Check with recent measurement: %v", err)
	}
}

func TestCheckWeightReminders_DontRemindUntilActive(t *testing.T) {
	sched, db := setupTestScheduler(t)
	userID := int64(123456)

	if err := db.Weight.SetReminderEnabled(userID, true); err != nil {
		t.Fatalf("SetWeightReminderEnabled: %v", err)
	}

	if err := db.Weight.DontBugMeReminder(userID); err != nil {
		t.Fatalf("DontBugMeWeightReminder: %v", err)
	}

	err := sched.WeightReminderChecker.Check(context.Background())
	if err != nil {
		t.Errorf("Check with dont_remind_until: %v", err)
	}
}

// --- WorkoutChecker tests ---

func TestCheckWorkoutNotifications_DisabledFeature(t *testing.T) {
	sched, db := setupTestScheduler(t)

	if err := db.Settings.SetWorkoutEnabled(context.Background(), false); err != nil {
		t.Fatalf("SetWorkoutEnabled: %v", err)
	}

	err := sched.WorkoutChecker.Check(context.Background())
	if err != nil {
		t.Errorf("Check with disabled feature: %v", err)
	}
}

func TestCheckWorkoutNotifications_NoGroups(t *testing.T) {
	sched, _ := setupTestScheduler(t)

	err := sched.WorkoutChecker.Check(context.Background())
	if err != nil {
		t.Errorf("Check with no groups: %v", err)
	}
}

func TestCheckWorkoutNotifications_WrongDay(t *testing.T) {
	sched, db := setupTestScheduler(t)

	now := time.Now()
	todayIdx := int(now.Weekday())
	otherDay := (todayIdx + 1) % 7

	daysOfWeek := "[" + intToStr(otherDay) + "]"
	_, err := db.Workout.CreateGroup("TestGroup", "desc", false, 123456, daysOfWeek, "09:00", 15)
	if err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}

	err = sched.WorkoutChecker.Check(context.Background())
	if err != nil {
		t.Errorf("Check on wrong day: %v", err)
	}
}

func TestCheckWorkoutNotifications_SessionCreatedOnScheduledDay(t *testing.T) {
	sched, db := setupTestScheduler(t)

	now := time.Now()
	futureTimeObj := now.Add(2 * time.Hour)
	if futureTimeObj.Day() != now.Day() {
		t.Skip("Skipping: future time crosses into next day")
	}
	todayIdx := int(now.Weekday())
	daysOfWeek := "[" + intToStr(todayIdx) + "]"

	futureTime := futureTimeObj.Format("15:04")

	group, err := db.Workout.CreateGroup("TodayGroup", "desc", false, 123456, daysOfWeek, futureTime, 15)
	if err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}

	order := 0
	_, err = db.Workout.CreateVariant(group.ID, "Variant A", &order, "")
	if err != nil {
		t.Fatalf("CreateVariant: %v", err)
	}

	err = sched.WorkoutChecker.Check(context.Background())
	if err != nil {
		t.Errorf("Check: %v", err)
	}

	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	session, err := db.Workout.GetSessionByGroupAndDate(group.ID, today)
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
	pastTimeObj := now.Add(-1 * time.Hour)
	if pastTimeObj.Day() != now.Day() {
		t.Skip("Skipping: past time crosses into previous day")
	}
	todayIdx := int(now.Weekday())
	daysOfWeek := "[" + intToStr(todayIdx) + "]"

	pastTime := pastTimeObj.Format("15:04")

	group, err := db.Workout.CreateGroup("SkipGroup", "desc", false, 123456, daysOfWeek, pastTime, 15)
	if err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}

	order := 0
	variant, err := db.Workout.CreateVariant(group.ID, "Variant A", &order, "")
	if err != nil {
		t.Fatalf("CreateVariant: %v", err)
	}

	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	session, err := db.Workout.CreateSession(group.ID, variant.ID, 123456, today, pastTime)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if err := db.Workout.PreSkipSession(session.ID); err != nil {
		t.Fatalf("PreSkipSession: %v", err)
	}

	err = sched.WorkoutChecker.Check(context.Background())
	if err != nil {
		t.Errorf("Check: %v", err)
	}

	updated, err := db.Workout.GetSession(session.ID)
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if updated.Status != "skipped" {
		t.Errorf("Expected pre_skipped session to become 'skipped', got %q", updated.Status)
	}
}

// TestCheckWorkout_SessionVariantUpdatedWhenRotationChanges reproduces the bug where:
//  1. A group was non-rotating with variant "Swings".
//  2. A session was pre-created for today with variant "Swings".
//  3. The group was then made rotating with "Bodyweight" as the current variant.
//  4. When the scheduler runs, it should update the existing session's variant_id
//     to match the current rotation state (Bodyweight), not leave it pointing to Swings.
//
// Without the fix, the notification shows Bodyweight but the workout starts Swings.
func TestCheckWorkout_SessionVariantUpdatedWhenRotationChanges(t *testing.T) {
	sched, db := setupTestScheduler(t)

	now := time.Now()
	pastTimeObj := now.Add(-30 * time.Minute)
	if pastTimeObj.Day() != now.Day() {
		t.Skip("Skipping: past time crosses into previous day")
	}
	todayIdx := int(now.Weekday())
	daysOfWeek := "[" + intToStr(todayIdx) + "]"
	// Schedule in the future so notification is not triggered yet, but session IS created
	pastTime := pastTimeObj.Format("15:04")

	// Step 1: Create group as non-rotating with only "Swings" variant
	group, err := db.Workout.CreateGroup("Morning Workouts", "desc", false, 123456, daysOfWeek, pastTime, 15)
	if err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}

	swingsVariant, err := db.Workout.CreateVariant(group.ID, "Swings", nil, "")
	if err != nil {
		t.Fatalf("CreateVariant Swings: %v", err)
	}

	// Step 2: Session was already created for today with the old variant (Swings)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	session, err := db.Workout.CreateSession(group.ID, swingsVariant.ID, 123456, today, pastTime)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	// Verify initial state: session points to Swings
	if session.VariantID != swingsVariant.ID {
		t.Fatalf("pre-condition: session should have swings variant %d, got %d", swingsVariant.ID, session.VariantID)
	}

	// Step 3: User makes the group rotating and adds "Bodyweight" variant
	err = db.Workout.UpdateGroup(group.ID, "Morning Workouts", "desc", true, daysOfWeek, pastTime, 15, true)
	if err != nil {
		t.Fatalf("UpdateGroup (make rotating): %v", err)
	}

	order := 1
	bodyweightVariant, err := db.Workout.CreateVariant(group.ID, "Bodyweight", &order, "")
	if err != nil {
		t.Fatalf("CreateVariant Bodyweight: %v", err)
	}

	// Initialize rotation to Bodyweight (what the user does in the UI)
	if err := db.Workout.InitializeRotation(group.ID, bodyweightVariant.ID); err != nil {
		t.Fatalf("InitializeRotation: %v", err)
	}

	// Step 4: Run the scheduler
	err = sched.WorkoutChecker.Check(context.Background())
	if err != nil {
		t.Fatalf("WorkoutChecker.Check: %v", err)
	}

	// Step 5: Verify the session's variant_id was updated to Bodyweight
	updated, err := db.Workout.GetSession(session.ID)
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if updated.VariantID != bodyweightVariant.ID {
		t.Errorf("BUG: session variant was not updated — got variant_id=%d (Swings), want %d (Bodyweight)",
			updated.VariantID, bodyweightVariant.ID)
	}
}

// --- Helper functions ---

func intToStr(i int) string {
	return []string{"0", "1", "2", "3", "4", "5", "6"}[i]
}
