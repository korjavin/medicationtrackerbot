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

// mockNotifier records all Send/Delete calls for test assertions.
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
	UserID int64
	MsgID  int
}

func (m *mockNotifier) Send(_ context.Context, userID int64, n notifier.Notification) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sendCalls = append(m.sendCalls, mockSendCall{UserID: userID, Notification: n})
	return m.sendMsgID, m.sendErr
}

func (m *mockNotifier) Delete(_ context.Context, userID int64, msgID int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.deleteCalls = append(m.deleteCalls, mockDeleteCall{UserID: userID, MsgID: msgID})
	return m.deleteErr
}

func (m *mockNotifier) getSendCalls() []mockSendCall {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := make([]mockSendCall, len(m.sendCalls))
	copy(cp, m.sendCalls)
	return cp
}

func (m *mockNotifier) getDeleteCalls() []mockDeleteCall {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := make([]mockDeleteCall, len(m.deleteCalls))
	copy(cp, m.deleteCalls)
	return cp
}

// waitForSendCalls waits until the mock has at least n Send calls, or times out.
func (m *mockNotifier) waitForSendCalls(n int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		m.mu.Lock()
		count := len(m.sendCalls)
		m.mu.Unlock()
		if count >= n {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return false
}

func (m *mockNotifier) waitForDeleteCalls(n int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		m.mu.Lock()
		count := len(m.deleteCalls)
		m.mu.Unlock()
		if count >= n {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return false
}

func setupTestSchedulerWithMock(t *testing.T) (*Scheduler, *store.Store, *mockNotifier) {
	t.Helper()
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	mock := &mockNotifier{sendMsgID: 100}
	sched := New(db, 123456, []notifier.Notifier{mock})
	return sched, db, mock
}

// --- notify() / deleteNotification() helper tests ---

func TestNotify_CallsAllNotifiers(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	m1 := &mockNotifier{sendMsgID: 10}
	m2 := &mockNotifier{sendMsgID: 0} // simulates WebPush (no msg tracking)
	sched := New(db, 42, []notifier.Notifier{m1, m2})

	n := notifier.Notification{Text: "test", Tag: "t"}
	var storedID int
	sched.notify(context.Background(), n, func(id int) { storedID = id })

	// Wait for goroutines
	m1.waitForSendCalls(1, time.Second)
	m2.waitForSendCalls(1, time.Second)

	calls1 := m1.getSendCalls()
	calls2 := m2.getSendCalls()
	if len(calls1) != 1 {
		t.Errorf("m1: expected 1 send call, got %d", len(calls1))
	}
	if len(calls2) != 1 {
		t.Errorf("m2: expected 1 send call, got %d", len(calls2))
	}
	if calls1[0].UserID != 42 {
		t.Errorf("m1: userID = %d, want 42", calls1[0].UserID)
	}
	// storeMsgID should have been called with m1's msgID (10)
	// Note: goroutine race means we can't guarantee order, but at least one should store
	time.Sleep(50 * time.Millisecond) // allow storeMsgID goroutine to complete
	if storedID != 10 {
		t.Errorf("storedID = %d, want 10", storedID)
	}
}

func TestNotify_NoNotifiers(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	sched := New(db, 42, nil)
	// Should not panic with nil notifiers
	sched.notify(context.Background(), notifier.Notification{Text: "test"}, nil)
}

func TestDeleteNotification_CallsAllNotifiers(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	m1 := &mockNotifier{}
	m2 := &mockNotifier{}
	sched := New(db, 42, []notifier.Notifier{m1, m2})

	sched.deleteNotification(context.Background(), 99)

	m1.waitForDeleteCalls(1, time.Second)
	m2.waitForDeleteCalls(1, time.Second)

	calls1 := m1.getDeleteCalls()
	calls2 := m2.getDeleteCalls()
	if len(calls1) != 1 || calls1[0].MsgID != 99 {
		t.Errorf("m1: expected delete(99), got %v", calls1)
	}
	if len(calls2) != 1 || calls2[0].MsgID != 99 {
		t.Errorf("m2: expected delete(99), got %v", calls2)
	}
}

func TestDeleteNotification_ZeroMsgID_Noop(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	m := &mockNotifier{}
	sched := New(db, 42, []notifier.Notifier{m})

	sched.deleteNotification(context.Background(), 0)
	time.Sleep(50 * time.Millisecond)

	if len(m.getDeleteCalls()) != 0 {
		t.Error("expected no delete calls for msgID=0")
	}
}

func TestNotify_SendError_DoesNotCallStoreMsgID(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	m := &mockNotifier{sendErr: fmt.Errorf("network error")}
	sched := New(db, 42, []notifier.Notifier{m})

	called := false
	sched.notify(context.Background(), notifier.Notification{Text: "test"}, func(_ int) {
		called = true
	})

	m.waitForSendCalls(1, time.Second)
	time.Sleep(50 * time.Millisecond)

	if called {
		t.Error("storeMsgID should not have been called on send error")
	}
}

// --- checkSchedule with mock notifier ---

func TestCheckSchedule_SendsNotificationViaMock(t *testing.T) {
	sched, db, mock := setupTestSchedulerWithMock(t)

	// Create a daily medication scheduled 1 hour ago
	pastTime := time.Now().Add(-1 * time.Hour).Format("15:04")
	schedule := `{"type":"daily","times":["` + pastTime + `"]}`
	_, err := db.CreateMedication("TestMed", "10mg", schedule, nil, nil, "", "")
	if err != nil {
		t.Fatalf("CreateMedication: %v", err)
	}

	err = sched.checkSchedule()
	if err != nil {
		t.Fatalf("checkSchedule: %v", err)
	}

	// notify() uses goroutines, wait
	if !mock.waitForSendCalls(1, 2*time.Second) {
		t.Fatal("timed out waiting for send call")
	}

	calls := mock.getSendCalls()
	if len(calls) != 1 {
		t.Fatalf("expected 1 send call, got %d", len(calls))
	}

	n := calls[0].Notification

	// Check text contains medication name
	if !strings.Contains(n.Text, "TestMed") {
		t.Errorf("notification text should contain med name, got: %s", n.Text)
	}
	if !strings.Contains(n.Text, "10mg") {
		t.Errorf("notification text should contain dosage, got: %s", n.Text)
	}

	// Check actions: should have individual confirm + confirm all
	if len(n.Actions) < 2 {
		t.Fatalf("expected at least 2 actions, got %d", len(n.Actions))
	}
	// First action: individual confirm
	if !strings.Contains(n.Actions[0].ID, "confirm_intake:") {
		t.Errorf("first action should be confirm_intake, got %s", n.Actions[0].ID)
	}
	if n.Actions[0].Label != "Take TestMed" {
		t.Errorf("first action label = %q, want %q", n.Actions[0].Label, "Take TestMed")
	}
	// Last action: confirm all
	lastAction := n.Actions[len(n.Actions)-1]
	if !strings.Contains(lastAction.ID, "confirm_schedule:") {
		t.Errorf("last action should be confirm_schedule, got %s", lastAction.ID)
	}

	// Check tag
	if !strings.HasPrefix(n.Tag, "medication-") {
		t.Errorf("tag should start with medication-, got %s", n.Tag)
	}

	// Check metadata
	if n.Metadata["type"] != "medication" {
		t.Errorf("metadata type = %v, want medication", n.Metadata["type"])
	}

	// Verify intake was created
	pending, err := db.GetPendingIntakes()
	if err != nil {
		t.Fatalf("GetPendingIntakes: %v", err)
	}
	if len(pending) != 1 {
		t.Errorf("expected 1 pending intake, got %d", len(pending))
	}
}

func TestCheckSchedule_MultipleMeds_GroupedNotification(t *testing.T) {
	sched, db, mock := setupTestSchedulerWithMock(t)

	// Create two meds at the same time
	pastTime := time.Now().Add(-1 * time.Hour).Format("15:04")
	schedule := `{"type":"daily","times":["` + pastTime + `"]}`
	_, err := db.CreateMedication("MedA", "5mg", schedule, nil, nil, "", "")
	if err != nil {
		t.Fatalf("CreateMedication A: %v", err)
	}
	_, err = db.CreateMedication("MedB", "20mg", schedule, nil, nil, "", "")
	if err != nil {
		t.Fatalf("CreateMedication B: %v", err)
	}

	err = sched.checkSchedule()
	if err != nil {
		t.Fatalf("checkSchedule: %v", err)
	}

	if !mock.waitForSendCalls(1, 2*time.Second) {
		t.Fatal("timed out waiting for send call")
	}

	calls := mock.getSendCalls()
	if len(calls) != 1 {
		t.Fatalf("expected 1 grouped notification, got %d", len(calls))
	}

	n := calls[0].Notification
	// Both meds should be in the text
	if !strings.Contains(n.Text, "MedA") || !strings.Contains(n.Text, "MedB") {
		t.Errorf("notification should contain both med names, got: %s", n.Text)
	}

	// Should have 3 actions: Take MedA, Take MedB, Confirm ALL
	if len(n.Actions) != 3 {
		t.Errorf("expected 3 actions, got %d: %v", len(n.Actions), n.Actions)
	}
}

// --- checkReminders with mock notifier ---

func TestCheckReminders_SendsReminderForOldPending(t *testing.T) {
	sched, db, mock := setupTestSchedulerWithMock(t)

	// Create a medication and an old pending intake (>1 hour ago)
	pastTime := time.Now().Add(-2 * time.Hour)
	timeStr := pastTime.Format("15:04")
	schedule := `{"type":"daily","times":["` + timeStr + `"]}`
	medID, err := db.CreateMedication("ReminderMed", "5mg", schedule, nil, nil, "", "")
	if err != nil {
		t.Fatalf("CreateMedication: %v", err)
	}

	now := time.Now()
	target := time.Date(now.Year(), now.Month(), now.Day(),
		pastTime.Hour(), pastTime.Minute(), 0, 0, now.Location())
	_, err = db.CreateIntake(medID, 123456, target)
	if err != nil {
		t.Fatalf("CreateIntake: %v", err)
	}

	err = sched.checkReminders()
	if err != nil {
		t.Fatalf("checkReminders: %v", err)
	}

	if !mock.waitForSendCalls(1, 2*time.Second) {
		t.Fatal("timed out waiting for reminder send call")
	}

	calls := mock.getSendCalls()
	n := calls[0].Notification

	if !strings.Contains(n.Text, "REMINDER") {
		t.Errorf("reminder text should contain REMINDER, got: %s", n.Text)
	}
	if !strings.Contains(n.Text, "ReminderMed") {
		t.Errorf("reminder text should contain med name, got: %s", n.Text)
	}
	if len(n.Actions) != 1 {
		t.Fatalf("expected 1 action, got %d", len(n.Actions))
	}
	if !strings.Contains(n.Actions[0].ID, "confirm_intake:") {
		t.Errorf("action should be confirm_intake, got %s", n.Actions[0].ID)
	}
	if n.Metadata["type"] != "medication_reminder" {
		t.Errorf("metadata type = %v, want medication_reminder", n.Metadata["type"])
	}
}

// --- sendBPReminder with mock notifier ---

func TestSendBPReminder_Standard(t *testing.T) {
	sched, _, mock := setupTestSchedulerWithMock(t)

	err := sched.sendBPReminder(context.Background(), 123456, false)
	if err != nil {
		t.Fatalf("sendBPReminder: %v", err)
	}

	calls := mock.getSendCalls()
	if len(calls) != 1 {
		t.Fatalf("expected 1 send call, got %d", len(calls))
	}

	n := calls[0].Notification
	if !strings.Contains(n.Text, "blood pressure") {
		t.Errorf("BP text should mention blood pressure, got: %s", n.Text)
	}
	// Standard (not enhanced) should NOT contain warning
	if strings.Contains(n.Text, "higher than usual") {
		t.Error("standard BP reminder should not contain enhanced warning")
	}
	if len(n.Actions) != 3 {
		t.Fatalf("expected 3 actions, got %d", len(n.Actions))
	}
	if n.Actions[0].ID != "bp_confirm" {
		t.Errorf("first action = %s, want bp_confirm", n.Actions[0].ID)
	}
	if n.Actions[1].ID != "bp_snooze" {
		t.Errorf("second action = %s, want bp_snooze", n.Actions[1].ID)
	}
	if n.Actions[2].ID != "bp_dontbug" {
		t.Errorf("third action = %s, want bp_dontbug", n.Actions[2].ID)
	}
	if n.Tag != "bp-reminder" {
		t.Errorf("tag = %s, want bp-reminder", n.Tag)
	}
	if n.Metadata["type"] != "bp_reminder" {
		t.Errorf("metadata type = %v, want bp_reminder", n.Metadata["type"])
	}
	if n.Metadata["enhanced"] != false {
		t.Errorf("metadata enhanced = %v, want false", n.Metadata["enhanced"])
	}
}

func TestSendBPReminder_Enhanced(t *testing.T) {
	sched, _, mock := setupTestSchedulerWithMock(t)

	err := sched.sendBPReminder(context.Background(), 123456, true)
	if err != nil {
		t.Fatalf("sendBPReminder: %v", err)
	}

	calls := mock.getSendCalls()
	n := calls[0].Notification
	if !strings.Contains(n.Text, "higher than usual") {
		t.Error("enhanced BP reminder should contain warning text")
	}
	if n.Metadata["enhanced"] != true {
		t.Errorf("metadata enhanced = %v, want true", n.Metadata["enhanced"])
	}
}

func TestSendBPReminder_AllFail_ReturnsError(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	m := &mockNotifier{sendErr: fmt.Errorf("fail")}
	sched := New(db, 123456, []notifier.Notifier{m})

	err = sched.sendBPReminder(context.Background(), 123456, false)
	if err == nil {
		t.Error("expected error when all notifiers fail")
	}
	if !strings.Contains(err.Error(), "failed to send BP reminder") {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestSendBPReminder_StoresMsgID(t *testing.T) {
	sched, db, mock := setupTestSchedulerWithMock(t)
	mock.sendMsgID = 777

	// Enable BP reminders so DB state exists
	if err := db.SetBPReminderEnabled(123456, true); err != nil {
		t.Fatalf("SetBPReminderEnabled: %v", err)
	}

	err := sched.sendBPReminder(context.Background(), 123456, false)
	if err != nil {
		t.Fatalf("sendBPReminder: %v", err)
	}

	// Verify the notification state was updated
	state, err := db.GetBPReminderState(123456)
	if err != nil {
		t.Fatalf("GetBPReminderState: %v", err)
	}
	if state.LastNotificationSentAt == nil {
		t.Error("expected LastNotificationSentAt to be set")
	}
}

// --- sendWeightReminder with mock notifier ---

func TestSendWeightReminder_Standard(t *testing.T) {
	sched, _, mock := setupTestSchedulerWithMock(t)

	err := sched.sendWeightReminder(context.Background(), 123456)
	if err != nil {
		t.Fatalf("sendWeightReminder: %v", err)
	}

	calls := mock.getSendCalls()
	if len(calls) != 1 {
		t.Fatalf("expected 1 send call, got %d", len(calls))
	}

	n := calls[0].Notification
	if !strings.Contains(n.Text, "weight") {
		t.Errorf("weight text should mention weight, got: %s", n.Text)
	}
	if len(n.Actions) != 3 {
		t.Fatalf("expected 3 actions, got %d", len(n.Actions))
	}
	if n.Actions[0].ID != "weight_confirm" {
		t.Errorf("first action = %s, want weight_confirm", n.Actions[0].ID)
	}
	if n.Actions[1].ID != "weight_snooze" {
		t.Errorf("second action = %s, want weight_snooze", n.Actions[1].ID)
	}
	if n.Actions[2].ID != "weight_dontbug" {
		t.Errorf("third action = %s, want weight_dontbug", n.Actions[2].ID)
	}
	if n.Tag != "weight-reminder" {
		t.Errorf("tag = %s, want weight-reminder", n.Tag)
	}
	if n.Metadata["type"] != "weight_reminder" {
		t.Errorf("metadata type = %v, want weight_reminder", n.Metadata["type"])
	}
}

func TestSendWeightReminder_AllFail_ReturnsError(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	m := &mockNotifier{sendErr: fmt.Errorf("fail")}
	sched := New(db, 123456, []notifier.Notifier{m})

	err = sched.sendWeightReminder(context.Background(), 123456)
	if err == nil {
		t.Error("expected error when all notifiers fail")
	}
}

func TestSendWeightReminder_StoresMsgID(t *testing.T) {
	sched, db, mock := setupTestSchedulerWithMock(t)
	mock.sendMsgID = 888

	if err := db.SetWeightReminderEnabled(123456, true); err != nil {
		t.Fatalf("SetWeightReminderEnabled: %v", err)
	}

	err := sched.sendWeightReminder(context.Background(), 123456)
	if err != nil {
		t.Fatalf("sendWeightReminder: %v", err)
	}

	state, err := db.GetWeightReminderState(123456)
	if err != nil {
		t.Fatalf("GetWeightReminderState: %v", err)
	}
	if state.LastNotificationSentAt == nil {
		t.Error("expected LastNotificationSentAt to be set")
	}
}

// --- sendWorkoutNotification with mock notifier ---

func TestSendWorkoutNotification_BuildsCorrectNotification(t *testing.T) {
	sched, db, mock := setupTestSchedulerWithMock(t)

	now := time.Now()
	todayIdx := int(now.Weekday())
	daysOfWeek := "[" + intToStr(todayIdx) + "]"
	pastTime := now.Add(-30 * time.Minute).Format("15:04")

	group, err := db.CreateWorkoutGroup("Push Day", "desc", false, 123456, daysOfWeek, pastTime, 15)
	if err != nil {
		t.Fatalf("CreateWorkoutGroup: %v", err)
	}

	order := 0
	variant, err := db.CreateWorkoutVariant(group.ID, "Heavy", &order, "")
	if err != nil {
		t.Fatalf("CreateWorkoutVariant: %v", err)
	}

	// Add an exercise
	_, err = db.AddExerciseToVariant(variant.ID, "Bench Press", 4, 8, intPtr(10), floatPtr(80.0), 0)
	if err != nil {
		t.Fatalf("CreateWorkoutExercise: %v", err)
	}

	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	session, err := db.CreateWorkoutSession(group.ID, variant.ID, 123456, today, pastTime)
	if err != nil {
		t.Fatalf("CreateWorkoutSession: %v", err)
	}

	err = sched.sendWorkoutNotification(session, group, variant.ID)
	if err != nil {
		t.Fatalf("sendWorkoutNotification: %v", err)
	}

	if !mock.waitForSendCalls(1, 2*time.Second) {
		t.Fatal("timed out waiting for workout notification")
	}

	calls := mock.getSendCalls()
	n := calls[0].Notification

	// Check text
	if !strings.Contains(n.Text, "Push Day") {
		t.Errorf("should contain group name, got: %s", n.Text)
	}
	if !strings.Contains(n.Text, "Heavy") {
		t.Errorf("should contain variant name, got: %s", n.Text)
	}
	if !strings.Contains(n.Text, "Bench Press") {
		t.Errorf("should contain exercise name, got: %s", n.Text)
	}
	if !strings.Contains(n.Text, "80kg") {
		t.Errorf("should contain weight, got: %s", n.Text)
	}

	// Check actions
	if len(n.Actions) != 4 {
		t.Fatalf("expected 4 actions (start, snooze1, snooze2, skip), got %d", len(n.Actions))
	}
	if !strings.Contains(n.Actions[0].ID, "workout_start_") {
		t.Errorf("first action should be workout_start, got %s", n.Actions[0].ID)
	}
	if !strings.Contains(n.Actions[1].ID, "workout_snooze1_") {
		t.Errorf("second action should be snooze1, got %s", n.Actions[1].ID)
	}
	if !strings.Contains(n.Actions[3].ID, "workout_skip_") {
		t.Errorf("fourth action should be skip, got %s", n.Actions[3].ID)
	}

	// Check tag
	if !strings.HasPrefix(n.Tag, "workout-") {
		t.Errorf("tag should start with workout-, got %s", n.Tag)
	}

	// Check metadata
	if n.Metadata["type"] != "workout" {
		t.Errorf("metadata type = %v, want workout", n.Metadata["type"])
	}
	if n.Metadata["group_name"] != "Push Day" {
		t.Errorf("metadata group_name = %v, want Push Day", n.Metadata["group_name"])
	}
}

func TestSendWorkoutNotification_DeletesPreviousNotification(t *testing.T) {
	sched, db, mock := setupTestSchedulerWithMock(t)

	now := time.Now()
	todayIdx := int(now.Weekday())
	daysOfWeek := "[" + intToStr(todayIdx) + "]"
	pastTime := now.Add(-30 * time.Minute).Format("15:04")

	group, err := db.CreateWorkoutGroup("Leg Day", "desc", false, 123456, daysOfWeek, pastTime, 15)
	if err != nil {
		t.Fatalf("CreateWorkoutGroup: %v", err)
	}

	order := 0
	variant, err := db.CreateWorkoutVariant(group.ID, "A", &order, "")
	if err != nil {
		t.Fatalf("CreateWorkoutVariant: %v", err)
	}

	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	session, err := db.CreateWorkoutSession(group.ID, variant.ID, 123456, today, pastTime)
	if err != nil {
		t.Fatalf("CreateWorkoutSession: %v", err)
	}

	// Set a previous notification message ID
	if err := db.SetSessionNotificationMessageID(session.ID, 555); err != nil {
		t.Fatalf("SetSessionNotificationMessageID: %v", err)
	}
	// Reload session
	session, err = db.GetWorkoutSession(session.ID)
	if err != nil {
		t.Fatalf("GetWorkoutSession: %v", err)
	}

	err = sched.sendWorkoutNotification(session, group, variant.ID)
	if err != nil {
		t.Fatalf("sendWorkoutNotification: %v", err)
	}

	// Wait for delete of previous + send of new
	if !mock.waitForDeleteCalls(1, 2*time.Second) {
		t.Fatal("timed out waiting for delete call")
	}

	delCalls := mock.getDeleteCalls()
	if len(delCalls) != 1 {
		t.Fatalf("expected 1 delete call, got %d", len(delCalls))
	}
	if delCalls[0].MsgID != 555 {
		t.Errorf("deleted msgID = %d, want 555", delCalls[0].MsgID)
	}
}

func TestSendWorkoutNotification_StoresMessageID(t *testing.T) {
	sched, db, mock := setupTestSchedulerWithMock(t)
	mock.sendMsgID = 999

	now := time.Now()
	todayIdx := int(now.Weekday())
	daysOfWeek := "[" + intToStr(todayIdx) + "]"
	pastTime := now.Add(-30 * time.Minute).Format("15:04")

	group, err := db.CreateWorkoutGroup("Arms", "desc", false, 123456, daysOfWeek, pastTime, 15)
	if err != nil {
		t.Fatalf("CreateWorkoutGroup: %v", err)
	}

	order := 0
	variant, err := db.CreateWorkoutVariant(group.ID, "A", &order, "")
	if err != nil {
		t.Fatalf("CreateWorkoutVariant: %v", err)
	}

	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	session, err := db.CreateWorkoutSession(group.ID, variant.ID, 123456, today, pastTime)
	if err != nil {
		t.Fatalf("CreateWorkoutSession: %v", err)
	}

	err = sched.sendWorkoutNotification(session, group, variant.ID)
	if err != nil {
		t.Fatalf("sendWorkoutNotification: %v", err)
	}

	if !mock.waitForSendCalls(1, 2*time.Second) {
		t.Fatal("timed out waiting for send call")
	}
	time.Sleep(50 * time.Millisecond) // allow storeMsgID callback

	// Reload session and check stored message ID
	updated, err := db.GetWorkoutSession(session.ID)
	if err != nil {
		t.Fatalf("GetWorkoutSession: %v", err)
	}
	if updated.NotificationMessageID == nil {
		t.Error("expected notification message ID to be stored")
	} else if *updated.NotificationMessageID != 999 {
		t.Errorf("stored msgID = %d, want 999", *updated.NotificationMessageID)
	}
}

// --- Multiple notifiers tests ---

func TestMultipleNotifiers_BothCalled(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	m1 := &mockNotifier{sendMsgID: 100}
	m2 := &mockNotifier{sendMsgID: 0}
	sched := New(db, 123456, []notifier.Notifier{m1, m2})

	// Enable weight reminders
	if err := db.SetWeightReminderEnabled(123456, true); err != nil {
		t.Fatalf("SetWeightReminderEnabled: %v", err)
	}

	err = sched.sendWeightReminder(context.Background(), 123456)
	if err != nil {
		t.Fatalf("sendWeightReminder: %v", err)
	}

	// Both should be called (synchronous for weight)
	calls1 := m1.getSendCalls()
	calls2 := m2.getSendCalls()
	if len(calls1) != 1 {
		t.Errorf("m1: expected 1 call, got %d", len(calls1))
	}
	if len(calls2) != 1 {
		t.Errorf("m2: expected 1 call, got %d", len(calls2))
	}
}

func TestMultipleNotifiers_PartialFailure_StillSucceeds(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	failing := &mockNotifier{sendErr: fmt.Errorf("telegram down")}
	working := &mockNotifier{sendMsgID: 0}
	sched := New(db, 123456, []notifier.Notifier{failing, working})

	if err := db.SetWeightReminderEnabled(123456, true); err != nil {
		t.Fatalf("SetWeightReminderEnabled: %v", err)
	}

	// Should succeed because at least one notifier works
	err = sched.sendWeightReminder(context.Background(), 123456)
	if err != nil {
		t.Errorf("expected success with partial failure, got: %v", err)
	}
}

// --- checkSchedule stores intake reminder msg IDs ---

func TestCheckSchedule_StoresIntakeReminderMsgID(t *testing.T) {
	sched, db, mock := setupTestSchedulerWithMock(t)
	mock.sendMsgID = 321

	pastTime := time.Now().Add(-1 * time.Hour).Format("15:04")
	schedule := `{"type":"daily","times":["` + pastTime + `"]}`
	_, err := db.CreateMedication("MsgIDMed", "1mg", schedule, nil, nil, "", "")
	if err != nil {
		t.Fatalf("CreateMedication: %v", err)
	}

	err = sched.checkSchedule()
	if err != nil {
		t.Fatalf("checkSchedule: %v", err)
	}

	if !mock.waitForSendCalls(1, 2*time.Second) {
		t.Fatal("timed out waiting for send call")
	}
	// Allow storeMsgID callback to run
	time.Sleep(100 * time.Millisecond)

	// Verify intakes were created and have reminder msg IDs
	pending, err := db.GetPendingIntakes()
	if err != nil {
		t.Fatalf("GetPendingIntakes: %v", err)
	}
	if len(pending) != 1 {
		t.Fatalf("expected 1 pending intake, got %d", len(pending))
	}
	// The store.AddIntakeReminder stores the msg ID — verify by checking
	// the intake's reminder_message_ids field
	reminders, err := db.GetIntakeReminders(pending[0].ID)
	if err != nil {
		t.Fatalf("GetIntakeReminders: %v", err)
	}
	if len(reminders) == 0 {
		t.Error("expected intake to have reminder message ID stored")
	}
}

// --- Helpers ---

func intPtr(i int) *int         { return &i }
func floatPtr(f float64) *float64 { return &f }
