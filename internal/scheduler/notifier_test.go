package scheduler

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// mockNotifier records Send/Delete calls. Use waitForSendCalls /
// waitForDeleteCalls (not time.Sleep) to assert against async dispatch.
type mockNotifier struct {
	mu          sync.Mutex
	sendCalls   []mockSendCall
	deleteCalls []mockDeleteCall
	sendMsgID   int
	sendErr     error
	deleteErr   error
}

type mockSendCall struct {
	UserID       int64
	Notification notifier.Notification
}

type mockDeleteCall struct {
	Ctx    context.Context
	UserID int64
	MsgID  int
}

func (m *mockNotifier) Send(_ context.Context, userID int64, n notifier.Notification) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sendCalls = append(m.sendCalls, mockSendCall{UserID: userID, Notification: n})
	return m.sendMsgID, m.sendErr
}

func (m *mockNotifier) Delete(ctx context.Context, userID int64, msgID int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.deleteCalls = append(m.deleteCalls, mockDeleteCall{Ctx: ctx, UserID: userID, MsgID: msgID})
	return m.deleteErr
}

func (m *mockNotifier) CloseNotification(_ context.Context, _ int64, _ string) error {
	return nil
}

func (m *mockNotifier) getSendCalls() []mockSendCall {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]mockSendCall(nil), m.sendCalls...)
}

func (m *mockNotifier) getDeleteCalls() []mockDeleteCall {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]mockDeleteCall(nil), m.deleteCalls...)
}

func (m *mockNotifier) waitForSendCalls(n int, timeout time.Duration) bool {
	return waitUntil(timeout, func() bool { return len(m.getSendCalls()) >= n })
}

func (m *mockNotifier) waitForDeleteCalls(n int, timeout time.Duration) bool {
	return waitUntil(timeout, func() bool { return len(m.getDeleteCalls()) >= n })
}

// waitUntil polls cond every 5ms until it returns true or timeout elapses.
func waitUntil(timeout time.Duration, cond func() bool) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return false
}

func setupTestSchedulerWithMock(t *testing.T) (*Scheduler, *store.Store, *mockNotifier) {
	t.Helper()
	mock := &mockNotifier{sendMsgID: 100}
	sched, db := newSchedWithNotifiers(t, mock)
	return sched, db, mock
}

func newSchedWithNotifiers(t *testing.T, notifiers ...notifier.Notifier) (*Scheduler, *store.Store) {
	t.Helper()
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() }) // #nosec G104
	return NewWithNotifiers(db, 123456, notifiers), db
}

// findBatchedNotification returns the first send call with Metadata["type"]
// == metaType. Fatals if none match.
func findBatchedNotification(t *testing.T, calls []mockSendCall, metaType string) notifier.Notification {
	t.Helper()
	for _, c := range calls {
		if c.Notification.Metadata["type"] == metaType {
			return c.Notification
		}
	}
	t.Fatalf("no notification with metadata type=%q in %d calls", metaType, len(calls))
	return notifier.Notification{}
}

// assertActionIDs fatals if action IDs don't match want exactly.
func assertActionIDs(t *testing.T, actions []notifier.Action, want ...string) {
	t.Helper()
	if len(actions) != len(want) {
		t.Fatalf("expected %d actions, got %d", len(want), len(actions))
	}
	for i, w := range want {
		if actions[i].ID != w {
			t.Errorf("action[%d] = %s, want %s", i, actions[i].ID, w)
		}
	}
}

// hasActionWithPrefix reports whether any action.ID starts with prefix.
func hasActionWithPrefix(actions []notifier.Action, prefix string) bool {
	for _, a := range actions {
		if strings.HasPrefix(a.ID, prefix) {
			return true
		}
	}
	return false
}

// setupMedAtNoon pins both medication-checker clocks to noon and creates a daily med scheduled for 10:00 (created 24h before noon).
func setupMedAtNoon(t *testing.T, name, dosage string) (*Scheduler, *store.Store, *mockNotifier, int64, time.Time) {
	t.Helper()
	sched, db, mock := setupTestSchedulerWithMock(t)
	now := time.Now()
	fakeNow := time.Date(now.Year(), now.Month(), now.Day(), 12, 0, 0, 0, now.Location())
	sched.MedicationChecker.now = func() time.Time { return fakeNow }
	sched.MedicationReminderChecker.now = func() time.Time { return fakeNow }
	id, err := db.Medication.Create(name, dosage, `{"type":"daily","times":["10:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := db.Medication.UpdateCreatedAt(id, fakeNow.Add(-24*time.Hour)); err != nil {
		t.Fatalf("UpdateCreatedAt: %v", err)
	}
	return sched, db, mock, id, fakeNow
}

// setupWorkoutSession creates a workout group+variant scheduled for the current weekday at -30m (so it is due) plus an associated session.
func setupWorkoutSession(t *testing.T, groupName, variantName string) (*Scheduler, *store.Store, *mockNotifier, *store.WorkoutGroup, *store.WorkoutVariant, *store.WorkoutSession) {
	t.Helper()
	sched, db, mock := setupTestSchedulerWithMock(t)
	now := time.Now()
	daysOfWeek := "[" + intToStr(int(now.Weekday())) + "]"
	pastTime := now.Add(-30 * time.Minute).Format("15:04")
	group, err := db.Workout.CreateGroup(groupName, "desc", false, 123456, daysOfWeek, pastTime, 15)
	if err != nil {
		t.Fatalf("CreateWorkoutGroup: %v", err)
	}
	order := 0
	variant, err := db.Workout.CreateVariant(group.ID, variantName, &order, "")
	if err != nil {
		t.Fatalf("CreateWorkoutVariant: %v", err)
	}
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	session, err := db.Workout.CreateSession(group.ID, variant.ID, 123456, today, pastTime)
	if err != nil {
		t.Fatalf("CreateWorkoutSession: %v", err)
	}
	return sched, db, mock, group, variant, session
}

// Async Notify / DeleteNotification fan-out is covered by the
// TestWebPushSink_* tests in sink_webpush_test.go (which exercise the same
// code paths via the public constructor); the integration-level checker tests
// below verify that the scheduler wires the sink through to each checker.

func TestMedicationChecker_Check(t *testing.T) {
	// Combined check of: batched notification structure (text, actions, tag,
	// metadata), pending-intake creation, and async intake-reminder msgID
	// storage — all observable on a single Check run.
	t.Run("single med batched notification + stores intake reminder msgID", func(t *testing.T) {
		sched, db, mock, _, _ := setupMedAtNoon(t, "TestMed", "10mg")
		mock.sendMsgID = 321

		if err := sched.MedicationChecker.Check(context.Background()); err != nil {
			t.Fatalf("Check: %v", err)
		}
		if !mock.waitForSendCalls(2, 2*time.Second) {
			t.Fatal("timed out waiting for send calls")
		}
		calls := mock.getSendCalls()
		if len(calls) != 2 {
			t.Fatalf("expected 2 send calls, got %d", len(calls))
		}
		n := findBatchedNotification(t, calls, "medication_batch")

		if !strings.Contains(n.Text, "TestMed") || !strings.Contains(n.Text, "10mg") {
			t.Errorf("notification text should contain name+dosage, got: %s", n.Text)
		}
		if len(n.Actions) < 2 {
			t.Fatalf("expected at least 2 actions, got %d", len(n.Actions))
		}
		if !strings.Contains(n.Actions[0].ID, "confirm_intake:") {
			t.Errorf("first action = %s, want confirm_intake", n.Actions[0].ID)
		}
		if n.Actions[0].Label != "Take TestMed" {
			t.Errorf("first action label = %q, want %q", n.Actions[0].Label, "Take TestMed")
		}
		if last := n.Actions[len(n.Actions)-1]; !strings.Contains(last.ID, "confirm_schedule:") {
			t.Errorf("last action = %s, want confirm_schedule", last.ID)
		}
		if !strings.HasPrefix(n.Tag, "medication-") {
			t.Errorf("tag = %s, want prefix medication-", n.Tag)
		}
		if n.Metadata["type"] != "medication_batch" {
			t.Errorf("metadata type = %v, want medication_batch", n.Metadata["type"])
		}

		// Allow the async StoreIntakeReminderMsgID goroutine to complete.
		time.Sleep(100 * time.Millisecond)
		pending, err := db.Medication.ListPendingIntakes()
		if err != nil {
			t.Fatalf("ListPendingIntakes: %v", err)
		}
		if len(pending) != 1 {
			t.Fatalf("expected 1 pending intake, got %d", len(pending))
		}
		reminders, err := db.Medication.ListIntakeReminders(pending[0].ID)
		if err != nil {
			t.Fatalf("ListIntakeReminders: %v", err)
		}
		if len(reminders) == 0 {
			t.Error("expected intake to have reminder message ID stored")
		}
	})

	t.Run("multiple meds are grouped in batched notification", func(t *testing.T) {
		sched, db, mock, _, fakeNow := setupMedAtNoon(t, "MedA", "5mg")
		idB, err := db.Medication.Create("MedB", "20mg", `{"type":"daily","times":["10:00"]}`, nil, nil, "", "", "")
		if err != nil {
			t.Fatalf("Create B: %v", err)
		}
		if err := db.Medication.UpdateCreatedAt(idB, fakeNow.Add(-24*time.Hour)); err != nil {
			t.Fatalf("UpdateCreatedAt B: %v", err)
		}

		if err := sched.MedicationChecker.Check(context.Background()); err != nil {
			t.Fatalf("Check: %v", err)
		}
		// 1 batched (Telegram) + 2 individual (one per med).
		if !mock.waitForSendCalls(3, 2*time.Second) {
			t.Fatal("timed out waiting for send calls")
		}
		calls := mock.getSendCalls()
		if len(calls) != 3 {
			t.Fatalf("expected 3 notifications, got %d", len(calls))
		}
		n := findBatchedNotification(t, calls, "medication_batch")
		if !strings.Contains(n.Text, "MedA") || !strings.Contains(n.Text, "MedB") {
			t.Errorf("batched text should contain both med names, got: %s", n.Text)
		}
		if len(n.Actions) != 5 {
			t.Errorf("expected 5 actions (take a, skip a, take b, skip b, confirm all), got %d: %v", len(n.Actions), n.Actions)
		}
	})

	t.Run("supplement med adds skip action", func(t *testing.T) {
		sched, db, mock, medID, _ := setupMedAtNoon(t, "Magnesium", "200mg")
		if err := db.Medication.SetSupplement(medID, true); err != nil {
			t.Fatalf("SetSupplement: %v", err)
		}

		if err := sched.MedicationChecker.Check(context.Background()); err != nil {
			t.Fatalf("Check: %v", err)
		}
		if !mock.waitForSendCalls(2, 2*time.Second) {
			t.Fatal("timed out waiting for send calls")
		}
		n := findBatchedNotification(t, mock.getSendCalls(), "medication_batch")
		if !hasActionWithPrefix(n.Actions, "confirm_intake:") {
			t.Error("expected confirm_intake action for supplement")
		}
		if !hasActionWithPrefix(n.Actions, "skip_intake:") {
			t.Error("expected skip_intake action for supplement")
		}
	})
}

func TestMedicationReminderChecker_Check(t *testing.T) {
	t.Run("sends reminder for pending intake older than threshold", func(t *testing.T) {
		sched, db, mock, medID, fakeNow := setupMedAtNoon(t, "ReminderMed", "5mg")
		// Target is 09:00 — 3h before noon, past the >1h reminder threshold.
		target := time.Date(fakeNow.Year(), fakeNow.Month(), fakeNow.Day(), 9, 0, 0, 0, fakeNow.Location())
		if _, err := db.Medication.CreateIntake(medID, 123456, target); err != nil {
			t.Fatalf("CreateIntake: %v", err)
		}

		if err := sched.MedicationReminderChecker.Check(context.Background()); err != nil {
			t.Fatalf("Check: %v", err)
		}
		if !mock.waitForSendCalls(1, 2*time.Second) {
			t.Fatal("timed out waiting for reminder")
		}
		n := mock.getSendCalls()[0].Notification
		if !strings.Contains(n.Text, "REMINDER") || !strings.Contains(n.Text, "ReminderMed") {
			t.Errorf("reminder text should contain REMINDER + med name, got: %s", n.Text)
		}
		if len(n.Actions) != 2 {
			t.Fatalf("expected 2 actions (confirm + skip), got %d", len(n.Actions))
		}
		if !hasActionWithPrefix(n.Actions, "confirm_intake:") {
			t.Errorf("expected a confirm_intake action, got %v", n.Actions)
		}
		if n.Metadata["type"] != "medication_reminder" {
			t.Errorf("metadata type = %v, want medication_reminder", n.Metadata["type"])
		}
	})

	// Repros the "reminder body shows UTC clock" bug: scheduled_at is stored
	// in UTC but must be rendered in the user's stored timezone.
	t.Run("formats scheduled_at in user timezone", func(t *testing.T) {
		sched, db, mock := setupTestSchedulerWithMock(t)
		if err := db.TZ.Record("America/Los_Angeles"); err != nil {
			t.Fatalf("Record: %v", err)
		}
		la, _ := time.LoadLocation("America/Los_Angeles")
		scheduled := time.Date(2026, 5, 4, 21, 18, 0, 0, time.UTC) // 14:18 PDT
		fakeNow := scheduled.Add(2 * time.Hour)
		sched.MedicationReminderChecker.now = func() time.Time { return fakeNow }

		medID, err := db.Medication.Create("Lercanidipin", "10mg",
			`{"type":"daily","times":["08:20","21:30"]}`, nil, nil, "", "", "medium")
		if err != nil {
			t.Fatalf("Create: %v", err)
		}
		if _, err := db.Medication.CreateIntake(medID, 123456, scheduled); err != nil {
			t.Fatalf("CreateIntake: %v", err)
		}

		if err := sched.MedicationReminderChecker.Check(context.Background()); err != nil {
			t.Fatalf("Check: %v", err)
		}
		if !mock.waitForSendCalls(1, 2*time.Second) {
			t.Fatal("timed out waiting for reminder")
		}
		want := scheduled.In(la).Format("15:04") // 14:18
		body := mock.getSendCalls()[0].Notification.Text
		if !strings.Contains(body, want) {
			t.Errorf("reminder body must contain user-local %q, got: %s", want, body)
		}
		if bogus := scheduled.UTC().Format("15:04"); want != bogus && strings.Contains(body, bogus) {
			t.Errorf("reminder body must NOT contain raw UTC %q, got: %s", bogus, body)
		}
	})

	t.Run("supplement reminder includes skip action", func(t *testing.T) {
		sched, db, mock, medID, fakeNow := setupMedAtNoon(t, "Vitamin D", "1000IU")
		if err := db.Medication.SetSupplement(medID, true); err != nil {
			t.Fatalf("SetSupplement: %v", err)
		}
		target := time.Date(fakeNow.Year(), fakeNow.Month(), fakeNow.Day(), 9, 0, 0, 0, fakeNow.Location())
		if _, err := db.Medication.CreateIntake(medID, 123456, target); err != nil {
			t.Fatalf("CreateIntake: %v", err)
		}

		if err := sched.MedicationReminderChecker.Check(context.Background()); err != nil {
			t.Fatalf("Check: %v", err)
		}
		if !mock.waitForSendCalls(1, 2*time.Second) {
			t.Fatal("timed out waiting for reminder")
		}
		n := mock.getSendCalls()[0].Notification
		if !hasActionWithPrefix(n.Actions, "confirm_intake:") {
			t.Error("expected confirm_intake action in reminder")
		}
		if !hasActionWithPrefix(n.Actions, "skip_intake:") {
			t.Error("expected skip_intake action in reminder for supplement")
		}
	})
}

func TestBPReminderChecker_SendBPReminder(t *testing.T) {
	t.Run("standard reminder builds 3 actions + bp metadata", func(t *testing.T) {
		sched, _, mock := setupTestSchedulerWithMock(t)
		if err := sched.BPReminderChecker.sendBPReminder(context.Background(), 123456, false); err != nil {
			t.Fatalf("sendBPReminder: %v", err)
		}
		calls := mock.getSendCalls()
		if len(calls) != 1 {
			t.Fatalf("expected 1 send call, got %d", len(calls))
		}
		n := calls[0].Notification
		if !strings.Contains(n.Text, "blood pressure") {
			t.Errorf("text should mention blood pressure, got: %s", n.Text)
		}
		if strings.Contains(n.Text, "higher than usual") {
			t.Error("standard reminder should not contain enhanced warning")
		}
		assertActionIDs(t, n.Actions, "bp_confirm", "bp_snooze", "bp_dontbug")
		if n.Tag != "bp-reminder" {
			t.Errorf("tag = %s, want bp-reminder", n.Tag)
		}
		if n.Metadata["type"] != "bp_reminder" {
			t.Errorf("metadata type = %v, want bp_reminder", n.Metadata["type"])
		}
		if n.Metadata["enhanced"] != false {
			t.Errorf("metadata enhanced = %v, want false", n.Metadata["enhanced"])
		}
	})

	t.Run("enhanced reminder adds warning + enhanced metadata", func(t *testing.T) {
		sched, _, mock := setupTestSchedulerWithMock(t)
		if err := sched.BPReminderChecker.sendBPReminder(context.Background(), 123456, true); err != nil {
			t.Fatalf("sendBPReminder: %v", err)
		}
		n := mock.getSendCalls()[0].Notification
		if !strings.Contains(n.Text, "higher than usual") {
			t.Error("enhanced reminder should contain warning text")
		}
		if n.Metadata["enhanced"] != true {
			t.Errorf("metadata enhanced = %v, want true", n.Metadata["enhanced"])
		}
	})

	t.Run("returns error when all notifiers fail", func(t *testing.T) {
		sched, _ := newSchedWithNotifiers(t, &mockNotifier{sendErr: fmt.Errorf("fail")})
		err := sched.BPReminderChecker.sendBPReminder(context.Background(), 123456, false)
		if err == nil {
			t.Error("expected error when all notifiers fail")
		}
		if err != nil && !strings.Contains(err.Error(), "failed to send BP reminder") {
			t.Errorf("unexpected error message: %v", err)
		}
	})

	t.Run("updates LastNotificationSentAt", func(t *testing.T) {
		sched, db, mock := setupTestSchedulerWithMock(t)
		mock.sendMsgID = 777
		if err := db.BP.SetReminderEnabled(123456, true); err != nil {
			t.Fatalf("SetBPReminderEnabled: %v", err)
		}

		if err := sched.BPReminderChecker.sendBPReminder(context.Background(), 123456, false); err != nil {
			t.Fatalf("sendBPReminder: %v", err)
		}
		state, err := db.BP.GetReminderState(123456)
		if err != nil {
			t.Fatalf("GetBPReminderState: %v", err)
		}
		if state.LastNotificationSentAt == nil {
			t.Error("expected LastNotificationSentAt to be set")
		}
	})
}

func TestWeightReminderChecker_SendWeightReminder(t *testing.T) {
	t.Run("standard reminder builds 3 actions + weight metadata", func(t *testing.T) {
		sched, _, mock := setupTestSchedulerWithMock(t)
		if err := sched.WeightReminderChecker.sendWeightReminder(context.Background(), 123456); err != nil {
			t.Fatalf("sendWeightReminder: %v", err)
		}
		calls := mock.getSendCalls()
		if len(calls) != 1 {
			t.Fatalf("expected 1 send call, got %d", len(calls))
		}
		n := calls[0].Notification
		if !strings.Contains(n.Text, "weight") {
			t.Errorf("text should mention weight, got: %s", n.Text)
		}
		assertActionIDs(t, n.Actions, "weight_confirm", "weight_snooze", "weight_dontbug")
		if n.Tag != "weight-reminder" {
			t.Errorf("tag = %s, want weight-reminder", n.Tag)
		}
		if n.Metadata["type"] != "weight_reminder" {
			t.Errorf("metadata type = %v, want weight_reminder", n.Metadata["type"])
		}
	})

	t.Run("returns error when all notifiers fail", func(t *testing.T) {
		sched, _ := newSchedWithNotifiers(t, &mockNotifier{sendErr: fmt.Errorf("fail")})
		if err := sched.WeightReminderChecker.sendWeightReminder(context.Background(), 123456); err == nil {
			t.Error("expected error when all notifiers fail")
		}
	})

	t.Run("updates LastNotificationSentAt", func(t *testing.T) {
		sched, db, mock := setupTestSchedulerWithMock(t)
		mock.sendMsgID = 888
		if err := db.Weight.SetReminderEnabled(123456, true); err != nil {
			t.Fatalf("SetWeightReminderEnabled: %v", err)
		}

		if err := sched.WeightReminderChecker.sendWeightReminder(context.Background(), 123456); err != nil {
			t.Fatalf("sendWeightReminder: %v", err)
		}
		state, err := db.Weight.GetReminderState(123456)
		if err != nil {
			t.Fatalf("GetWeightReminderState: %v", err)
		}
		if state.LastNotificationSentAt == nil {
			t.Error("expected LastNotificationSentAt to be set")
		}
	})
}

func TestWorkoutChecker_SendWorkoutNotification(t *testing.T) {
	t.Run("builds notification with text, actions, tag, and metadata", func(t *testing.T) {
		sched, db, mock, group, variant, session := setupWorkoutSession(t, "Push Day", "Heavy")
		if _, err := db.Workout.CreateExerciseInVariant(variant.ID, "Bench Press", 4, 8, intPtr(10), floatPtr(80.0), 0); err != nil {
			t.Fatalf("AddExerciseToVariant: %v", err)
		}

		if err := sched.WorkoutChecker.sendWorkoutNotification(session, group, variant.ID); err != nil {
			t.Fatalf("sendWorkoutNotification: %v", err)
		}
		if !mock.waitForSendCalls(1, 2*time.Second) {
			t.Fatal("timed out waiting for workout notification")
		}
		n := mock.getSendCalls()[0].Notification
		for _, want := range []string{"Push Day", "Heavy", "Bench Press", "80kg"} {
			if !strings.Contains(n.Text, want) {
				t.Errorf("text should contain %q, got: %s", want, n.Text)
			}
		}
		if len(n.Actions) != 4 {
			t.Fatalf("expected 4 actions (start, snooze1, snooze2, skip), got %d", len(n.Actions))
		}
		if !strings.Contains(n.Actions[0].ID, "workout_start_") {
			t.Errorf("action[0] = %s, want workout_start prefix", n.Actions[0].ID)
		}
		if !strings.Contains(n.Actions[1].ID, "workout_snooze1_") {
			t.Errorf("action[1] = %s, want workout_snooze1 prefix", n.Actions[1].ID)
		}
		if !strings.Contains(n.Actions[3].ID, "workout_skip_") {
			t.Errorf("action[3] = %s, want workout_skip prefix", n.Actions[3].ID)
		}
		if !strings.HasPrefix(n.Tag, "workout-") {
			t.Errorf("tag = %s, want workout- prefix", n.Tag)
		}
		if n.Metadata["type"] != "workout" {
			t.Errorf("metadata type = %v, want workout", n.Metadata["type"])
		}
		if n.Metadata["group_name"] != "Push Day" {
			t.Errorf("metadata group_name = %v, want Push Day", n.Metadata["group_name"])
		}
	})

	t.Run("deletes previously stored notification before sending", func(t *testing.T) {
		sched, db, mock, group, variant, session := setupWorkoutSession(t, "Leg Day", "A")
		if err := db.Workout.SetSessionNotificationMessageID(session.ID, 555); err != nil {
			t.Fatalf("SetSessionNotificationMessageID: %v", err)
		}
		reloaded, err := db.Workout.GetSession(session.ID)
		if err != nil {
			t.Fatalf("GetWorkoutSession: %v", err)
		}

		if err := sched.WorkoutChecker.sendWorkoutNotification(reloaded, group, variant.ID); err != nil {
			t.Fatalf("sendWorkoutNotification: %v", err)
		}
		if !mock.waitForDeleteCalls(1, 2*time.Second) {
			t.Fatal("timed out waiting for delete call")
		}
		dc := mock.getDeleteCalls()
		if len(dc) != 1 {
			t.Fatalf("expected 1 delete call, got %d", len(dc))
		}
		if dc[0].MsgID != 555 {
			t.Errorf("deleted msgID = %d, want 555", dc[0].MsgID)
		}
	})

	t.Run("stores returned message ID on session", func(t *testing.T) {
		sched, db, mock, group, variant, session := setupWorkoutSession(t, "Arms", "A")
		mock.sendMsgID = 999

		if err := sched.WorkoutChecker.sendWorkoutNotification(session, group, variant.ID); err != nil {
			t.Fatalf("sendWorkoutNotification: %v", err)
		}
		if !mock.waitForSendCalls(1, 2*time.Second) {
			t.Fatal("timed out waiting for send call")
		}
		time.Sleep(50 * time.Millisecond)

		updated, err := db.Workout.GetSession(session.ID)
		if err != nil {
			t.Fatalf("GetWorkoutSession: %v", err)
		}
		if updated.NotificationMessageID == nil {
			t.Error("expected notification message ID to be stored")
		} else if *updated.NotificationMessageID != 999 {
			t.Errorf("stored msgID = %d, want 999", *updated.NotificationMessageID)
		}
	})
}

func TestMultipleNotifiers(t *testing.T) {
	enableWeight := func(t *testing.T, db *store.Store) {
		t.Helper()
		if err := db.Weight.SetReminderEnabled(123456, true); err != nil {
			t.Fatalf("SetWeightReminderEnabled: %v", err)
		}
	}

	t.Run("all notifiers receive the send", func(t *testing.T) {
		m1 := &mockNotifier{sendMsgID: 100}
		m2 := &mockNotifier{sendMsgID: 0}
		sched, db := newSchedWithNotifiers(t, m1, m2)
		enableWeight(t, db)

		if err := sched.WeightReminderChecker.sendWeightReminder(context.Background(), 123456); err != nil {
			t.Fatalf("sendWeightReminder: %v", err)
		}
		if c := m1.getSendCalls(); len(c) != 1 {
			t.Errorf("m1: expected 1 call, got %d", len(c))
		}
		if c := m2.getSendCalls(); len(c) != 1 {
			t.Errorf("m2: expected 1 call, got %d", len(c))
		}
	})

	t.Run("partial failure still succeeds overall", func(t *testing.T) {
		failing := &mockNotifier{sendErr: fmt.Errorf("telegram down")}
		working := &mockNotifier{sendMsgID: 0}
		sched, db := newSchedWithNotifiers(t, failing, working)
		enableWeight(t, db)

		if err := sched.WeightReminderChecker.sendWeightReminder(context.Background(), 123456); err != nil {
			t.Errorf("expected success with partial failure, got: %v", err)
		}
	})
}

func TestLowStockChecker_Check(t *testing.T) {
	// runAt11AM creates a daily medication with the given inventory count,
	// pins the LowStockChecker clock to 11:00 today, and runs Check.
	runAt11AM := func(t *testing.T, name string, count int) (*Scheduler, *mockNotifier) {
		t.Helper()
		sched, db, mock := setupTestSchedulerWithMock(t)
		medID, err := db.Medication.Create(name, "10mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "")
		if err != nil {
			t.Fatalf("Create: %v", err)
		}
		c := count
		if err := db.Medication.SetInventory(medID, &c); err != nil {
			t.Fatalf("SetInventory: %v", err)
		}
		now := time.Now()
		elevenAM := time.Date(now.Year(), now.Month(), now.Day(), 11, 0, 0, 0, now.Location())
		sched.LowStockChecker.now = func() time.Time { return elevenAM }
		if err := sched.LowStockChecker.Check(context.Background()); err != nil {
			t.Fatalf("Check: %v", err)
		}
		return sched, mock
	}

	t.Run("sends notification when inventory below threshold", func(t *testing.T) {
		_, mock := runAt11AM(t, "Aspirin", 5)
		if !mock.waitForSendCalls(1, 2*time.Second) {
			t.Fatal("timed out waiting for low-stock notification")
		}
		calls := mock.getSendCalls()
		if len(calls) != 1 {
			t.Fatalf("expected 1 send call, got %d", len(calls))
		}
		n := calls[0].Notification
		if !strings.Contains(n.Text, "Aspirin") {
			t.Errorf("notification should mention med name, got: %s", n.Text)
		}
		if !strings.Contains(n.Text, "Low Stock") {
			t.Errorf("notification should contain 'Low Stock', got: %s", n.Text)
		}
		if n.Tag != "low-stock" {
			t.Errorf("tag = %q, want 'low-stock'", n.Tag)
		}
		if n.Metadata["type"] != "low_stock" {
			t.Errorf("metadata type = %v, want low_stock", n.Metadata["type"])
		}
	})

	t.Run("no notification when inventory is adequate", func(t *testing.T) {
		_, mock := runAt11AM(t, "Vitamin", 50)
		time.Sleep(50 * time.Millisecond)
		if c := mock.getSendCalls(); len(c) != 0 {
			t.Errorf("expected no notification when stock is adequate, got %d calls", len(c))
		}
	})

	t.Run("lastCheck is updated after Check (pre/post zero check)", func(t *testing.T) {
		sched, db, mock := setupTestSchedulerWithMock(t)
		medID, err := db.Medication.Create("LowMed", "10mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "")
		if err != nil {
			t.Fatalf("Create: %v", err)
		}
		count := 3
		if err := db.Medication.SetInventory(medID, &count); err != nil {
			t.Fatalf("SetInventory: %v", err)
		}
		now := time.Now()
		elevenAM := time.Date(now.Year(), now.Month(), now.Day(), 11, 0, 0, 0, now.Location())
		sched.LowStockChecker.now = func() time.Time { return elevenAM }

		if !sched.LowStockChecker.lastCheck.IsZero() {
			t.Fatal("pre-condition: lastCheck should be zero before first Check")
		}
		if err := sched.LowStockChecker.Check(context.Background()); err != nil {
			t.Fatalf("Check: %v", err)
		}
		mock.waitForSendCalls(1, 2*time.Second)
		time.Sleep(50 * time.Millisecond)
		if sched.LowStockChecker.lastCheck.IsZero() {
			t.Error("expected lastCheck to be updated after first Check")
		}
	})
}

// --- Helpers ---

func intPtr(i int) *int           { return &i }
func floatPtr(f float64) *float64 { return &f }
