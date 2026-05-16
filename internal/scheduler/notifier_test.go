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
	t.Cleanup(func() { _ = db.Close() }) // #nosec G104

	mock := &mockNotifier{sendMsgID: 100}
	sched := New(db, 123456, []notifier.Notifier{mock})
	return sched, db, mock
}

// --- NotifyHelper tests ---

func TestNotify_CallsAllNotifiers(t *testing.T) {
	m1 := &mockNotifier{sendMsgID: 10}
	m2 := &mockNotifier{sendMsgID: 0}
	helper := NotifyHelper{
		notifiers:     []notifier.Notifier{m1, m2},
		allowedUserID: 42,
	}

	n := notifier.Notification{Text: "test", Tag: "t"}
	var storedID int
	helper.Notify(context.Background(), n, func(id int) { storedID = id })

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
	time.Sleep(50 * time.Millisecond)
	if storedID != 10 {
		t.Errorf("storedID = %d, want 10", storedID)
	}
}

func TestNotify_NoNotifiers(t *testing.T) {
	helper := NotifyHelper{notifiers: nil, allowedUserID: 42}
	// Should not panic with nil notifiers
	helper.Notify(context.Background(), notifier.Notification{Text: "test"}, nil)
}

func TestDeleteNotification_CallsAllNotifiers(t *testing.T) {
	m1 := &mockNotifier{}
	m2 := &mockNotifier{}
	helper := NotifyHelper{
		notifiers:     []notifier.Notifier{m1, m2},
		allowedUserID: 42,
	}

	type ctxKey struct{}
	ctx := context.WithValue(context.Background(), ctxKey{}, "test")

	helper.DeleteNotification(ctx, 99)

	m1.waitForDeleteCalls(1, time.Second)
	m2.waitForDeleteCalls(1, time.Second)

	calls1 := m1.getDeleteCalls()
	calls2 := m2.getDeleteCalls()
	if len(calls1) != 1 || calls1[0].MsgID != 99 || calls1[0].UserID != 42 || calls1[0].Ctx != ctx {
		t.Errorf("m1: expected delete(99) with ctx and UserID=42, got %v", calls1)
	}
	if len(calls2) != 1 || calls2[0].MsgID != 99 || calls2[0].UserID != 42 || calls2[0].Ctx != ctx {
		t.Errorf("m2: expected delete(99) with ctx and UserID=42, got %v", calls2)
	}
}

func TestDeleteNotification_ZeroMsgID_Noop(t *testing.T) {
	m := &mockNotifier{}
	helper := NotifyHelper{
		notifiers:     []notifier.Notifier{m},
		allowedUserID: 42,
	}

	helper.DeleteNotification(context.Background(), 0)
	time.Sleep(50 * time.Millisecond)

	if len(m.getDeleteCalls()) != 0 {
		t.Error("expected no delete calls for msgID=0")
	}
}

func TestNotify_SendError_DoesNotCallStoreMsgID(t *testing.T) {
	m := &mockNotifier{sendErr: fmt.Errorf("network error")}
	helper := NotifyHelper{
		notifiers:     []notifier.Notifier{m},
		allowedUserID: 42,
	}

	called := false
	helper.Notify(context.Background(), notifier.Notification{Text: "test"}, func(_ int) {
		called = true
	})

	m.waitForSendCalls(1, time.Second)
	time.Sleep(50 * time.Millisecond)

	if called {
		t.Error("storeMsgID should not have been called on send error")
	}
}

// --- MedicationChecker with mock notifier ---

func TestCheckSchedule_SendsNotificationViaMock(t *testing.T) {
	sched, db, mock := setupTestSchedulerWithMock(t)

	// Use a fixed noon clock to avoid midnight-boundary failures.
	fakeNow := time.Date(time.Now().Year(), time.Now().Month(), time.Now().Day(), 12, 0, 0, 0, time.Now().Location())
	sched.MedicationChecker.now = func() time.Time { return fakeNow }

	schedule := `{"type":"daily","times":["10:00"]}` // 2 hours before noon
	id, err := db.Medication.Create("TestMed", "10mg", schedule, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := db.Medication.UpdateCreatedAt(id, fakeNow.Add(-24*time.Hour)); err != nil {
		t.Fatalf("UpdateCreatedAt: %v", err)
	}

	err = sched.MedicationChecker.Check(context.Background())
	if err != nil {
		t.Fatalf("Check: %v", err)
	}

	if !mock.waitForSendCalls(2, 2*time.Second) {
		t.Fatal("timed out waiting for send call")
	}

	calls := mock.getSendCalls()
	if len(calls) != 2 {
		t.Fatalf("expected 2 send calls, got %d", len(calls))
	}

	var batchedNotifierCall mockSendCall
	var foundBatched bool
	for _, call := range calls {
		if call.Notification.Metadata["type"] == "medication_batch" {
			batchedNotifierCall = call
			foundBatched = true
			break
		}
	}

	if !foundBatched {
		t.Fatal("expected batched notification to be sent")
	}

	n := batchedNotifierCall.Notification

	if !strings.Contains(n.Text, "TestMed") {
		t.Errorf("notification text should contain med name, got: %s", n.Text)
	}
	if !strings.Contains(n.Text, "10mg") {
		t.Errorf("notification text should contain dosage, got: %s", n.Text)
	}

	if len(n.Actions) < 2 {
		t.Fatalf("expected at least 2 actions, got %d", len(n.Actions))
	}
	if !strings.Contains(n.Actions[0].ID, "confirm_intake:") {
		t.Errorf("first action should be confirm_intake, got %s", n.Actions[0].ID)
	}
	if n.Actions[0].Label != "Take TestMed" {
		t.Errorf("first action label = %q, want %q", n.Actions[0].Label, "Take TestMed")
	}
	lastAction := n.Actions[len(n.Actions)-1]
	if !strings.Contains(lastAction.ID, "confirm_schedule:") {
		t.Errorf("last action should be confirm_schedule, got %s", lastAction.ID)
	}

	if !strings.HasPrefix(n.Tag, "medication-") {
		t.Errorf("tag should start with medication-, got %s", n.Tag)
	}

	if n.Metadata["type"] != "medication_batch" {
		t.Errorf("metadata type = %v, want medication_batch", n.Metadata["type"])
	}

	pending, err := db.Medication.ListPendingIntakes()
	if err != nil {
		t.Fatalf("GetPendingIntakes: %v", err)
	}
	if len(pending) != 1 {
		t.Errorf("expected 1 pending intake, got %d", len(pending))
	}
}

func TestCheckSchedule_MultipleMeds_GroupedNotification(t *testing.T) {
	sched, db, mock := setupTestSchedulerWithMock(t)

	fakeNow := time.Date(time.Now().Year(), time.Now().Month(), time.Now().Day(), 12, 0, 0, 0, time.Now().Location())
	sched.MedicationChecker.now = func() time.Time { return fakeNow }

	schedule := `{"type":"daily","times":["10:00"]}`
	idA, err := db.Medication.Create("MedA", "5mg", schedule, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create A: %v", err)
	}
	if err := db.Medication.UpdateCreatedAt(idA, fakeNow.Add(-24*time.Hour)); err != nil {
		t.Fatalf("UpdateCreatedAt A: %v", err)
	}
	idB, err := db.Medication.Create("MedB", "20mg", schedule, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create B: %v", err)
	}
	if err := db.Medication.UpdateCreatedAt(idB, fakeNow.Add(-24*time.Hour)); err != nil {
		t.Fatalf("UpdateCreatedAt B: %v", err)
	}

	err = sched.MedicationChecker.Check(context.Background())
	if err != nil {
		t.Fatalf("Check: %v", err)
	}

	// Expecting 1 batched (Telegram) + 2 individual (WebPush)
	if !mock.waitForSendCalls(3, 2*time.Second) {
		t.Fatal("timed out waiting for send calls")
	}

	calls := mock.getSendCalls()
	if len(calls) != 3 {
		t.Fatalf("expected 3 notifications, got %d", len(calls))
	}

	// We'll check the batched notification
	var batchedNotifierCall mockSendCall
	var foundBatched bool
	for _, call := range calls {
		if call.Notification.Metadata["type"] == "medication_batch" {
			batchedNotifierCall = call
			foundBatched = true
			break
		}
	}

	if !foundBatched {
		t.Fatal("expected batched notification to be sent")
	}

	n := batchedNotifierCall.Notification
	if !strings.Contains(n.Text, "MedA") || !strings.Contains(n.Text, "MedB") {
		t.Errorf("notification should contain both med names, got: %s", n.Text)
	}

	if len(n.Actions) != 5 {
		t.Errorf("expected 5 actions (take a, skip a, take b, skip b, confirm all), got %d: %v", len(n.Actions), n.Actions)
	}
}

func TestCheckSchedule_SupplementHasSkipAction(t *testing.T) {
	sched, db, mock := setupTestSchedulerWithMock(t)

	fakeNow := time.Date(time.Now().Year(), time.Now().Month(), time.Now().Day(), 12, 0, 0, 0, time.Now().Location())
	sched.MedicationChecker.now = func() time.Time { return fakeNow }

	schedule := `{"type":"daily","times":["10:00"]}`
	medID, err := db.Medication.Create("Magnesium", "200mg", schedule, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := db.Medication.UpdateCreatedAt(medID, fakeNow.Add(-24*time.Hour)); err != nil {
		t.Fatalf("UpdateCreatedAt: %v", err)
	}
	if err := db.Medication.SetSupplement(medID, true); err != nil {
		t.Fatalf("SetSupplement: %v", err)
	}

	err = sched.MedicationChecker.Check(context.Background())
	if err != nil {
		t.Fatalf("Check: %v", err)
	}

	// Wait for 1 batched and 1 individual
	if !mock.waitForSendCalls(2, 2*time.Second) {
		t.Fatal("timed out waiting for send call")
	}

	calls := mock.getSendCalls()
	if len(calls) != 2 {
		t.Fatalf("expected 2 notifications, got %d", len(calls))
	}

	var batchedNotifierCall mockSendCall
	var foundBatched bool
	for _, call := range calls {
		if call.Notification.Metadata["type"] == "medication_batch" {
			batchedNotifierCall = call
			foundBatched = true
			break
		}
	}

	if !foundBatched {
		t.Fatal("expected batched notification to be sent")
	}

	n := batchedNotifierCall.Notification
	hasTake := false
	hasSkip := false
	for _, action := range n.Actions {
		if strings.HasPrefix(action.ID, "confirm_intake:") {
			hasTake = true
		}
		if strings.HasPrefix(action.ID, "skip_intake:") {
			hasSkip = true
		}
	}
	if !hasTake {
		t.Fatal("expected confirm_intake action for supplement")
	}
	if !hasSkip {
		t.Fatal("expected skip_intake action for supplement")
	}
}

// --- MedicationReminderChecker with mock notifier ---

func TestCheckReminders_SendsReminderForOldPending(t *testing.T) {
	sched, db, mock := setupTestSchedulerWithMock(t)

	// Use a fixed noon clock to avoid midnight-boundary failures.
	fakeNow := time.Date(time.Now().Year(), time.Now().Month(), time.Now().Day(), 12, 0, 0, 0, time.Now().Location())
	sched.MedicationReminderChecker.now = func() time.Time { return fakeNow }

	schedule := `{"type":"daily","times":["09:00"]}`
	medID, err := db.Medication.Create("ReminderMed", "5mg", schedule, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Target is 09:00 today — 3 hours before fakeNow (noon), satisfying the >1h threshold.
	target := time.Date(fakeNow.Year(), fakeNow.Month(), fakeNow.Day(), 9, 0, 0, 0, fakeNow.Location())
	_, err = db.Medication.CreateIntake(medID, 123456, target)
	if err != nil {
		t.Fatalf("CreateIntake: %v", err)
	}

	err = sched.MedicationReminderChecker.Check(context.Background())
	if err != nil {
		t.Fatalf("Check: %v", err)
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
	// All pending intakes now get both confirm and skip actions on follow-up reminders.
	if len(n.Actions) != 2 {
		t.Fatalf("expected 2 actions (confirm + skip), got %d", len(n.Actions))
	}
	hasConfirm := false
	for _, a := range n.Actions {
		if strings.Contains(a.ID, "confirm_intake:") {
			hasConfirm = true
		}
	}
	if !hasConfirm {
		t.Errorf("expected a confirm_intake action, got %v", n.Actions)
	}
	if n.Metadata["type"] != "medication_reminder" {
		t.Errorf("metadata type = %v, want medication_reminder", n.Metadata["type"])
	}
}

// TestCheckReminders_FormatsScheduledAtInUserTimezone reproduces the
// reported "reminder shows old time" symptom: scheduled_at is stored in
// UTC, and printing it without a timezone conversion shows the UTC clock
// time on the user's phone instead of their local time. Set the user's
// timezone to LA, schedule an intake at 21:18 UTC (= 14:18 PDT), and
// assert the reminder body says "14:18", not "21:18".
func TestCheckReminders_FormatsScheduledAtInUserTimezone(t *testing.T) {
	sched, db, mock := setupTestSchedulerWithMock(t)

	if err := db.TZ.RecordTimezone("America/Los_Angeles"); err != nil {
		t.Fatalf("RecordTimezone: %v", err)
	}
	la, _ := time.LoadLocation("America/Los_Angeles")

	// fakeNow is two hours after the scheduled_at so the >1h reminder
	// threshold fires.
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
		t.Fatal("timed out waiting for reminder send call")
	}

	want := scheduled.In(la).Format("15:04") // 14:18
	body := mock.getSendCalls()[0].Notification.Text
	if !strings.Contains(body, want) {
		t.Errorf("reminder body must contain %q (user-local 15:04), got: %s", want, body)
	}
	bogus := scheduled.UTC().Format("15:04") // 21:18
	if strings.Contains(body, bogus) && want != bogus {
		t.Errorf("reminder body must NOT contain raw UTC %q, got: %s", bogus, body)
	}
}

func TestCheckReminders_SupplementHasSkipAction(t *testing.T) {
	sched, db, mock := setupTestSchedulerWithMock(t)

	fakeNow := time.Date(time.Now().Year(), time.Now().Month(), time.Now().Day(), 12, 0, 0, 0, time.Now().Location())
	sched.MedicationReminderChecker.now = func() time.Time { return fakeNow }

	schedule := `{"type":"daily","times":["09:00"]}`
	medID, err := db.Medication.Create("Vitamin D", "1000IU", schedule, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := db.Medication.SetSupplement(medID, true); err != nil {
		t.Fatalf("SetSupplement: %v", err)
	}

	target := time.Date(fakeNow.Year(), fakeNow.Month(), fakeNow.Day(), 9, 0, 0, 0, fakeNow.Location())
	_, err = db.Medication.CreateIntake(medID, 123456, target)
	if err != nil {
		t.Fatalf("CreateIntake: %v", err)
	}

	err = sched.MedicationReminderChecker.Check(context.Background())
	if err != nil {
		t.Fatalf("Check: %v", err)
	}

	if !mock.waitForSendCalls(1, 2*time.Second) {
		t.Fatal("timed out waiting for reminder send call")
	}

	calls := mock.getSendCalls()
	n := calls[0].Notification

	hasConfirm := false
	hasSkip := false
	for _, action := range n.Actions {
		if strings.HasPrefix(action.ID, "confirm_intake:") {
			hasConfirm = true
		}
		if strings.HasPrefix(action.ID, "skip_intake:") {
			hasSkip = true
		}
	}

	if !hasConfirm {
		t.Fatal("expected confirm_intake action in reminder")
	}
	if !hasSkip {
		t.Fatal("expected skip_intake action in reminder for supplement")
	}
}

// --- BPReminderChecker.sendBPReminder with mock notifier ---

func TestSendBPReminder_Standard(t *testing.T) {
	sched, _, mock := setupTestSchedulerWithMock(t)

	err := sched.BPReminderChecker.sendBPReminder(context.Background(), 123456, false)
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

	err := sched.BPReminderChecker.sendBPReminder(context.Background(), 123456, true)
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

	err = sched.BPReminderChecker.sendBPReminder(context.Background(), 123456, false)
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

	if err := db.BP.SetReminderEnabled(123456, true); err != nil {
		t.Fatalf("SetReminderEnabled: %v", err)
	}

	err := sched.BPReminderChecker.sendBPReminder(context.Background(), 123456, false)
	if err != nil {
		t.Fatalf("sendBPReminder: %v", err)
	}

	state, err := db.BP.GetReminderState(123456)
	if err != nil {
		t.Fatalf("GetReminderState: %v", err)
	}
	if state.LastNotificationSentAt == nil {
		t.Error("expected LastNotificationSentAt to be set")
	}
}

// --- WeightReminderChecker.sendWeightReminder with mock notifier ---

func TestSendWeightReminder_Standard(t *testing.T) {
	sched, _, mock := setupTestSchedulerWithMock(t)

	err := sched.WeightReminderChecker.sendWeightReminder(context.Background(), 123456)
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

	err = sched.WeightReminderChecker.sendWeightReminder(context.Background(), 123456)
	if err == nil {
		t.Error("expected error when all notifiers fail")
	}
}

func TestSendWeightReminder_StoresMsgID(t *testing.T) {
	sched, db, mock := setupTestSchedulerWithMock(t)
	mock.sendMsgID = 888

	if err := db.Weight.SetReminderEnabled(123456, true); err != nil {
		t.Fatalf("SetWeightReminderEnabled: %v", err)
	}

	err := sched.WeightReminderChecker.sendWeightReminder(context.Background(), 123456)
	if err != nil {
		t.Fatalf("sendWeightReminder: %v", err)
	}

	state, err := db.Weight.GetReminderState(123456)
	if err != nil {
		t.Fatalf("GetWeightReminderState: %v", err)
	}
	if state.LastNotificationSentAt == nil {
		t.Error("expected LastNotificationSentAt to be set")
	}
}

// --- WorkoutChecker.sendWorkoutNotification with mock notifier ---

func TestSendWorkoutNotification_BuildsCorrectNotification(t *testing.T) {
	sched, db, mock := setupTestSchedulerWithMock(t)

	now := time.Now()
	todayIdx := int(now.Weekday())
	daysOfWeek := "[" + intToStr(todayIdx) + "]"
	pastTime := now.Add(-30 * time.Minute).Format("15:04")

	group, err := db.Workout.CreateGroup("Push Day", "desc", false, 123456, daysOfWeek, pastTime, 15)
	if err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}

	order := 0
	variant, err := db.Workout.CreateVariant(group.ID, "Heavy", &order, "")
	if err != nil {
		t.Fatalf("CreateVariant: %v", err)
	}

	_, err = db.Workout.CreateExerciseInVariant(variant.ID, "Bench Press", 4, 8, intPtr(10), floatPtr(80.0), 0)
	if err != nil {
		t.Fatalf("CreateWorkoutExercise: %v", err)
	}

	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	session, err := db.Workout.CreateSession(group.ID, variant.ID, 123456, today, pastTime)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	err = sched.WorkoutChecker.sendWorkoutNotification(session, group, variant.ID)
	if err != nil {
		t.Fatalf("sendWorkoutNotification: %v", err)
	}

	if !mock.waitForSendCalls(1, 2*time.Second) {
		t.Fatal("timed out waiting for workout notification")
	}

	calls := mock.getSendCalls()
	n := calls[0].Notification

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

	if !strings.HasPrefix(n.Tag, "workout-") {
		t.Errorf("tag should start with workout-, got %s", n.Tag)
	}

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

	group, err := db.Workout.CreateGroup("Leg Day", "desc", false, 123456, daysOfWeek, pastTime, 15)
	if err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}

	order := 0
	variant, err := db.Workout.CreateVariant(group.ID, "A", &order, "")
	if err != nil {
		t.Fatalf("CreateVariant: %v", err)
	}

	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	session, err := db.Workout.CreateSession(group.ID, variant.ID, 123456, today, pastTime)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	if err := db.Workout.SetSessionNotificationMessageID(session.ID, 555); err != nil {
		t.Fatalf("SetSessionNotificationMessageID: %v", err)
	}
	session, err = db.Workout.GetSession(session.ID)
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}

	err = sched.WorkoutChecker.sendWorkoutNotification(session, group, variant.ID)
	if err != nil {
		t.Fatalf("sendWorkoutNotification: %v", err)
	}

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

	group, err := db.Workout.CreateGroup("Arms", "desc", false, 123456, daysOfWeek, pastTime, 15)
	if err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}

	order := 0
	variant, err := db.Workout.CreateVariant(group.ID, "A", &order, "")
	if err != nil {
		t.Fatalf("CreateVariant: %v", err)
	}

	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	session, err := db.Workout.CreateSession(group.ID, variant.ID, 123456, today, pastTime)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	err = sched.WorkoutChecker.sendWorkoutNotification(session, group, variant.ID)
	if err != nil {
		t.Fatalf("sendWorkoutNotification: %v", err)
	}

	if !mock.waitForSendCalls(1, 2*time.Second) {
		t.Fatal("timed out waiting for send call")
	}
	time.Sleep(50 * time.Millisecond)

	updated, err := db.Workout.GetSession(session.ID)
	if err != nil {
		t.Fatalf("GetSession: %v", err)
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

	if err := db.Weight.SetReminderEnabled(123456, true); err != nil {
		t.Fatalf("SetWeightReminderEnabled: %v", err)
	}

	err = sched.WeightReminderChecker.sendWeightReminder(context.Background(), 123456)
	if err != nil {
		t.Fatalf("sendWeightReminder: %v", err)
	}

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

	if err := db.Weight.SetReminderEnabled(123456, true); err != nil {
		t.Fatalf("SetWeightReminderEnabled: %v", err)
	}

	err = sched.WeightReminderChecker.sendWeightReminder(context.Background(), 123456)
	if err != nil {
		t.Errorf("expected success with partial failure, got: %v", err)
	}
}

// --- checkSchedule stores intake reminder msg IDs ---

func TestCheckSchedule_StoresIntakeReminderMsgID(t *testing.T) {
	sched, db, mock := setupTestSchedulerWithMock(t)
	mock.sendMsgID = 321

	fakeNow := time.Date(time.Now().Year(), time.Now().Month(), time.Now().Day(), 12, 0, 0, 0, time.Now().Location())
	sched.MedicationChecker.now = func() time.Time { return fakeNow }

	schedule := `{"type":"daily","times":["10:00"]}`
	id, err := db.Medication.Create("MsgIDMed", "1mg", schedule, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := db.Medication.UpdateCreatedAt(id, fakeNow.Add(-24*time.Hour)); err != nil {
		t.Fatalf("UpdateCreatedAt: %v", err)
	}

	err = sched.MedicationChecker.Check(context.Background())
	if err != nil {
		t.Fatalf("Check: %v", err)
	}

	if !mock.waitForSendCalls(1, 2*time.Second) {
		t.Fatal("timed out waiting for send call")
	}
	time.Sleep(100 * time.Millisecond)

	pending, err := db.Medication.ListPendingIntakes()
	if err != nil {
		t.Fatalf("GetPendingIntakes: %v", err)
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
}

// --- LowStockChecker notification tests ---

func TestCheckLowStock_SendsNotificationWhen11AM(t *testing.T) {
	sched, db, mock := setupTestSchedulerWithMock(t)

	// Create a daily medication with only 5 units inventory (< 7 days)
	medID, err := db.Medication.Create("Aspirin", "100mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	count := 5
	if err := db.Medication.SetInventory(medID, &count); err != nil {
		t.Fatalf("SetInventory: %v", err)
	}

	// Inject clock returning 11:00 AM today
	now := time.Now()
	elevenAM := time.Date(now.Year(), now.Month(), now.Day(), 11, 0, 0, 0, now.Location())
	sched.LowStockChecker.now = func() time.Time { return elevenAM }

	if err := sched.LowStockChecker.Check(context.Background()); err != nil {
		t.Fatalf("Check: %v", err)
	}

	if !mock.waitForSendCalls(1, 2*time.Second) {
		t.Fatal("timed out waiting for low-stock notification")
	}

	calls := mock.getSendCalls()
	if len(calls) != 1 {
		t.Fatalf("expected 1 send call, got %d", len(calls))
	}

	n := calls[0].Notification
	if !strings.Contains(n.Text, "Aspirin") {
		t.Errorf("notification should contain medication name, got: %s", n.Text)
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
}

func TestCheckLowStock_NoNotificationWhenEnoughStock(t *testing.T) {
	sched, db, mock := setupTestSchedulerWithMock(t)

	// Create a daily medication with plenty of inventory (50 > 7 days)
	medID, err := db.Medication.Create("Vitamin", "500mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	count := 50
	if err := db.Medication.SetInventory(medID, &count); err != nil {
		t.Fatalf("SetInventory: %v", err)
	}

	now := time.Now()
	elevenAM := time.Date(now.Year(), now.Month(), now.Day(), 11, 0, 0, 0, now.Location())
	sched.LowStockChecker.now = func() time.Time { return elevenAM }

	if err := sched.LowStockChecker.Check(context.Background()); err != nil {
		t.Fatalf("Check: %v", err)
	}

	time.Sleep(50 * time.Millisecond)
	calls := mock.getSendCalls()
	if len(calls) != 0 {
		t.Errorf("expected no notification when stock is adequate, got %d calls", len(calls))
	}
}

func TestCheckLowStock_LastCheckUpdatedAfterCheck(t *testing.T) {
	sched, db, mock := setupTestSchedulerWithMock(t)
	_ = mock

	// Create low-stock medication
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

	if sched.LowStockChecker.lastCheck.IsZero() == false {
		t.Fatal("pre-condition: lastCheck should be zero before first Check")
	}

	if err := sched.LowStockChecker.Check(context.Background()); err != nil {
		t.Fatalf("Check: %v", err)
	}

	// Wait for async notification to complete so lastCheck is updated
	mock.waitForSendCalls(1, 2*time.Second)
	time.Sleep(50 * time.Millisecond)

	if sched.LowStockChecker.lastCheck.IsZero() {
		t.Error("expected lastCheck to be updated after first Check")
	}
}

// --- Helpers ---

func intPtr(i int) *int           { return &i }
func floatPtr(f float64) *float64 { return &f }
