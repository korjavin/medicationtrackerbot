package scheduler

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// --- mock store ---

type mockTZPlanNotifierStore struct {
	plan              *store.TZTransitionPlan
	getPlanErr        error
	updatedStatus     string
	updatedUserAction string
	updatedExpected   string
	updateErr         error
}

func (m *mockTZPlanNotifierStore) GetLatestActiveOrPendingTZTransitionPlan() (*store.TZTransitionPlan, error) {
	return m.plan, m.getPlanErr
}

func (m *mockTZPlanNotifierStore) UpdateTZTransitionPlanStatus(id int64, newStatus, userAction, expectedStatus string) error {
	m.updatedStatus = newStatus
	m.updatedUserAction = userAction
	m.updatedExpected = expectedStatus
	return m.updateErr
}

// --- mock notifier ---

type capturingNotifier struct {
	sent []notifier.Notification
}

func (c *capturingNotifier) Send(_ context.Context, _ int64, n notifier.Notification) (int, error) {
	c.sent = append(c.sent, n)
	return 1, nil
}

func (c *capturingNotifier) Delete(_ context.Context, _ int64, _ int) error { return nil }
func (c *capturingNotifier) CloseNotification(_ context.Context, _ int64, _ string) error {
	return nil
}

// --- helpers ---

func newTZPlanNotifierWithMocks(ms *mockTZPlanNotifierStore, cn *capturingNotifier) *TZPlanNotifier {
	return &TZPlanNotifier{
		NotifyHelper: NotifyHelper{
			notifiers:     []notifier.Notifier{cn},
			allowedUserID: 42,
		},
		store: ms,
	}
}

// --- tests ---

func TestTZPlanNotifier_NoPlan(t *testing.T) {
	ms := &mockTZPlanNotifierStore{plan: nil}
	cn := &capturingNotifier{}
	notif := newTZPlanNotifierWithMocks(ms, cn)

	if err := notif.Check(context.Background()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	time.Sleep(10 * time.Millisecond) // let goroutines finish
	if len(cn.sent) != 0 {
		t.Errorf("expected 0 notifications, got %d", len(cn.sent))
	}
	if ms.updatedStatus != "" {
		t.Errorf("expected no status update, got %q", ms.updatedStatus)
	}
}

func TestTZPlanNotifier_NotifiedPlan_Skipped(t *testing.T) {
	// Plan is already NOTIFIED — should not trigger a new send.
	ms := &mockTZPlanNotifierStore{
		plan: &store.TZTransitionPlan{
			ID:     1,
			OldTZ:  "UTC",
			NewTZ:  "Europe/Berlin",
			Status: "NOTIFIED",
		},
	}
	cn := &capturingNotifier{}
	notif := newTZPlanNotifierWithMocks(ms, cn)

	if err := notif.Check(context.Background()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	time.Sleep(10 * time.Millisecond)
	if len(cn.sent) != 0 {
		t.Errorf("expected 0 notifications for NOTIFIED plan, got %d", len(cn.sent))
	}
}

func TestTZPlanNotifier_PendingApproval_SendsNotification(t *testing.T) {
	stepsJSON := `[{"PlanID":1,"MedicationID":10,"MedName":"Metformin","StepNumber":1,"TotalSteps":1,"ScheduledAt":"2026-04-08T10:00:00Z","Note":"Metformin (flexible — fast switch): step 1/1 — 10:00 UTC old / 12:00 CEST new"}]`
	ms := &mockTZPlanNotifierStore{
		plan: &store.TZTransitionPlan{
			ID:        2,
			OldTZ:     "UTC",
			NewTZ:     "Europe/Berlin",
			Status:    "PENDING_APPROVAL",
			StepsJSON: stepsJSON,
		},
	}
	cn := &capturingNotifier{}
	notif := newTZPlanNotifierWithMocks(ms, cn)

	if err := notif.Check(context.Background()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	time.Sleep(30 * time.Millisecond) // let goroutines finish

	if len(cn.sent) != 1 {
		t.Fatalf("expected 1 notification, got %d", len(cn.sent))
	}

	sent := cn.sent[0]

	// Safety block checks.
	if !strings.Contains(sent.Text, "No doses skipped") {
		t.Errorf("message missing 'No doses skipped': %s", sent.Text)
	}
	if !strings.Contains(sent.Text, "No double doses") {
		t.Errorf("message missing 'No double doses': %s", sent.Text)
	}
	// Per-med section.
	if !strings.Contains(sent.Text, "Metformin") {
		t.Errorf("message missing med name 'Metformin': %s", sent.Text)
	}
	if !strings.Contains(sent.Text, "flexible") {
		t.Errorf("message missing policy label 'flexible': %s", sent.Text)
	}

	// Buttons.
	if len(sent.Actions) != 2 {
		t.Fatalf("expected 2 actions (approve/reject), got %d", len(sent.Actions))
	}
	if sent.Actions[0].ID != "tz_plan_approve:2" {
		t.Errorf("unexpected approve action ID: %s", sent.Actions[0].ID)
	}
	if sent.Actions[1].ID != "tz_plan_reject:2" {
		t.Errorf("unexpected reject action ID: %s", sent.Actions[1].ID)
	}

	// Status transition.
	if ms.updatedStatus != "NOTIFIED" {
		t.Errorf("expected status to be updated to NOTIFIED, got %q", ms.updatedStatus)
	}
	if ms.updatedExpected != "PENDING_APPROVAL" {
		t.Errorf("expected status guard to be PENDING_APPROVAL, got %q", ms.updatedExpected)
	}
}

func TestTZPlanNotifier_NoSteps_MinimalMessage(t *testing.T) {
	ms := &mockTZPlanNotifierStore{
		plan: &store.TZTransitionPlan{
			ID:        3,
			OldTZ:     "UTC",
			NewTZ:     "America/New_York",
			Status:    "PENDING_APPROVAL",
			StepsJSON: "",
		},
	}
	cn := &capturingNotifier{}
	notif := newTZPlanNotifierWithMocks(ms, cn)

	if err := notif.Check(context.Background()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	time.Sleep(30 * time.Millisecond)
	if len(cn.sent) != 1 {
		t.Fatalf("expected 1 notification, got %d", len(cn.sent))
	}
	if !strings.Contains(cn.sent[0].Text, "No transition steps") {
		t.Errorf("expected 'No transition steps' message when steps empty")
	}
}

// --- formatTZPlanMessage unit tests ---

func TestFormatTZPlanMessage_SafetyBlock(t *testing.T) {
	plan := &store.TZTransitionPlan{
		ID:    1,
		OldTZ: "UTC",
		NewTZ: "Asia/Tokyo",
	}
	steps := []planStep{
		{
			MedicationID: 5,
			MedName:      "Aspirin",
			StepNumber:   1,
			TotalSteps:   3,
			ScheduledAt:  time.Now(),
			Note:         "Aspirin (strict — gradual shift): step 1/3 — 10:00 UTC old / 19:00 JST new",
		},
	}
	msg := formatTZPlanMessage(plan, steps)

	checks := []string{"No doses skipped", "No double doses", "Aspirin", "strict — gradual shift"}
	for _, c := range checks {
		if !strings.Contains(msg, c) {
			t.Errorf("message missing %q:\n%s", c, msg)
		}
	}
}

func TestExtractPolicyLabel(t *testing.T) {
	cases := []struct {
		note string
		want string
	}{
		{"Med (strict — gradual shift): step 1/2 — ...", " (strict — gradual shift)"},
		{"Med (flexible — fast switch): step 1/1 — ...", " (flexible — fast switch)"},
		{"no parens here", ""},
	}
	for _, tc := range cases {
		got := extractPolicyLabel(tc.note)
		if got != tc.want {
			t.Errorf("extractPolicyLabel(%q) = %q, want %q", tc.note, got, tc.want)
		}
	}
}

func TestFormatDuration(t *testing.T) {
	cases := []struct {
		d    time.Duration
		want string
	}{
		{2 * time.Hour, "2h"},
		{90 * time.Minute, "1h 30m"},
		{3 * time.Hour, "3h"},
	}
	for _, tc := range cases {
		got := formatDuration(tc.d)
		if got != tc.want {
			t.Errorf("formatDuration(%v) = %q, want %q", tc.d, got, tc.want)
		}
	}
}
