package scheduler

import (
	"context"
	"fmt"
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
	markNotifiedID    int64
	markNotifiedOK    bool // return value for MarkPlanNotified
	markNotifiedErr   error
	resetToPendingID  int64
	resetToPendingErr error
	// Captures calls to UpdateTZTransitionPlanStatus.
	updatedPlanID        int64
	updatedStatus        string
	updatedUserAction    string
	updatedExpectedState string
	// Captures calls to SetTZTransitionPlanApproved.
	approvedPlanID int64
	approvedOK     bool
	approvedErr    error
}

func (m *mockTZPlanNotifierStore) GetLatestActiveOrPendingTZTransitionPlan() (*store.TZTransitionPlan, error) {
	return m.plan, m.getPlanErr
}

func (m *mockTZPlanNotifierStore) MarkPlanNotified(id int64) (bool, error) {
	m.markNotifiedID = id
	return m.markNotifiedOK, m.markNotifiedErr
}

func (m *mockTZPlanNotifierStore) ResetPlanToPending(id int64) error {
	m.resetToPendingID = id
	return m.resetToPendingErr
}

func (m *mockTZPlanNotifierStore) UpdateTZTransitionPlanStatus(id int64, newStatus, userAction, expectedStatus string) error {
	m.updatedPlanID = id
	m.updatedStatus = newStatus
	m.updatedUserAction = userAction
	m.updatedExpectedState = expectedStatus
	return nil
}

func (m *mockTZPlanNotifierStore) SetTZTransitionPlanApproved(id int64, _ time.Time) (bool, error) {
	m.approvedPlanID = id
	return m.approvedOK, m.approvedErr
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
	if ms.markNotifiedID != 0 {
		t.Errorf("expected MarkPlanNotified not called, got ID %d", ms.markNotifiedID)
	}
}

func TestTZPlanNotifier_NotifiedPlan_RecentlyCreated_Skipped(t *testing.T) {
	// Plan is already NOTIFIED but notified recently — should not trigger send or auto-approve.
	notifiedAt := time.Now().Add(-1 * time.Hour)
	ms := &mockTZPlanNotifierStore{
		plan: &store.TZTransitionPlan{
			ID:         1,
			OldTZ:      "UTC",
			NewTZ:      "Europe/Berlin",
			Status:     "NOTIFIED",
			CreatedAt:  time.Now().Add(-2 * time.Hour),
			NotifiedAt: &notifiedAt, // notified 1h ago
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
	if ms.approvedPlanID != 0 {
		t.Errorf("expected no auto-approve for recent NOTIFIED plan, got plan ID %d", ms.approvedPlanID)
	}
}

func TestTZPlanNotifier_NotifiedPlan_Stale_AutoApproved(t *testing.T) {
	// Plan has been in NOTIFIED state for more than 48h — should be auto-approved.
	notifiedAt := time.Now().Add(-49 * time.Hour)
	ms := &mockTZPlanNotifierStore{
		plan: &store.TZTransitionPlan{
			ID:         7,
			OldTZ:      "UTC",
			NewTZ:      "Europe/Berlin",
			Status:     "NOTIFIED",
			CreatedAt:  time.Now().Add(-50 * time.Hour),
			NotifiedAt: &notifiedAt, // notified 49h ago
		},
		approvedOK: true,
	}
	cn := &capturingNotifier{}
	notif := newTZPlanNotifierWithMocks(ms, cn)

	if err := notif.Check(context.Background()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ms.approvedPlanID != 7 {
		t.Errorf("expected auto-approve for stale NOTIFIED plan ID 7, got %d", ms.approvedPlanID)
	}
	// No new notification should be sent — auto-approval is silent.
	if len(cn.sent) != 0 {
		t.Errorf("expected 0 notifications for auto-approved plan, got %d", len(cn.sent))
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
			CreatedAt: time.Now(),
		},
		markNotifiedOK: true, // CAS succeeds → we win, send notification
	}
	cn := &capturingNotifier{}
	notif := newTZPlanNotifierWithMocks(ms, cn)

	if err := notif.Check(context.Background()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	time.Sleep(30 * time.Millisecond) // let goroutines finish

	// MarkPlanNotified must have been called before notification was sent.
	if ms.markNotifiedID != 2 {
		t.Errorf("expected MarkPlanNotified called with plan ID 2, got %d", ms.markNotifiedID)
	}

	if len(cn.sent) != 1 {
		t.Fatalf("expected 1 notification, got %d", len(cn.sent))
	}

	sent := cn.sent[0]

	// Safety block checks.
	if !strings.Contains(sent.Text, "No doses skipped") {
		t.Errorf("message missing 'No doses skipped': %s", sent.Text)
	}
	if !strings.Contains(sent.Text, "Minimum safe interval") {
		t.Errorf("message missing safety interval claim: %s", sent.Text)
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
}

func TestTZPlanNotifier_PendingApproval_CASLost_NoSend(t *testing.T) {
	// When MarkPlanNotified returns false (another process won the CAS), no notification should be sent.
	ms := &mockTZPlanNotifierStore{
		plan: &store.TZTransitionPlan{
			ID:        3,
			OldTZ:     "UTC",
			NewTZ:     "Europe/Berlin",
			Status:    "PENDING_APPROVAL",
			CreatedAt: time.Now(),
		},
		markNotifiedOK: false, // CAS fails → another process won
	}
	cn := &capturingNotifier{}
	notif := newTZPlanNotifierWithMocks(ms, cn)

	if err := notif.Check(context.Background()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	time.Sleep(30 * time.Millisecond)

	if len(cn.sent) != 0 {
		t.Errorf("expected 0 notifications when CAS lost, got %d", len(cn.sent))
	}
}

func TestTZPlanNotifier_NoSteps_MinimalMessage(t *testing.T) {
	ms := &mockTZPlanNotifierStore{
		plan: &store.TZTransitionPlan{
			ID:        4,
			OldTZ:     "UTC",
			NewTZ:     "America/New_York",
			Status:    "PENDING_APPROVAL",
			StepsJSON: "",
			CreatedAt: time.Now(),
		},
		markNotifiedOK: true,
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

	checks := []string{"No doses skipped", "Minimum safe interval", "Aspirin", "strict — gradual shift"}
	for _, c := range checks {
		if !strings.Contains(msg, c) {
			t.Errorf("message missing %q:\n%s", c, msg)
		}
	}
}

// TestFormatTZPlanMessage_EscapesMarkdownV1 guards against the regression where
// IANA timezone IDs containing underscores (e.g. America/Los_Angeles) produced
// an unbalanced italic marker in the rendered Telegram Markdown V1 message,
// causing the API to reject delivery with "Bad Request: can't parse entities"
// and the user to silently miss the approval prompt.
func TestFormatTZPlanMessage_EscapesMarkdownV1(t *testing.T) {
	plan := &store.TZTransitionPlan{
		ID:    1,
		OldTZ: "Europe/Copenhagen",
		NewTZ: "America/Los_Angeles",
	}
	steps := []planStep{
		{
			MedicationID: 5,
			MedName:      "Met_former", // synthetic name with underscore to confirm name escaping
			StepNumber:   1,
			TotalSteps:   1,
			ScheduledAt:  time.Now(),
			Note:         "Met_former (flexible — fast switch): step 1/1 — 23:18 CEST old / 14:18 PDT new",
		},
	}
	msg := formatTZPlanMessage(plan, steps)

	// Underscores in dynamic strings must be backslash-escaped so MD V1 parser
	// does not see an unbalanced italic marker.
	mustContain := []string{
		`America/Los\_Angeles`,
		`Europe/Copenhagen`, // no underscore — passed through untouched
		`Met\_former`,
	}
	for _, s := range mustContain {
		if !strings.Contains(msg, s) {
			t.Errorf("expected escaped %q in message, got:\n%s", s, msg)
		}
	}

	// And we must NOT have left a bare unbalanced underscore in those strings.
	if strings.Contains(msg, "Los_Angeles") {
		t.Errorf("found unescaped 'Los_Angeles' in message:\n%s", msg)
	}

	// Sanity: there is an even number of unescaped `_` characters
	// (each remaining `_` is preceded by `\`, so MD V1 sees no entity boundaries).
	for i := 0; i < len(msg); i++ {
		if msg[i] == '_' {
			if i == 0 || msg[i-1] != '\\' {
				t.Errorf("unescaped `_` at byte offset %d in message:\n%s", i, msg)
				break
			}
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

// --- failing notifiers ---

type failingNotifier struct{}

func (f *failingNotifier) Send(_ context.Context, _ int64, _ notifier.Notification) (int, error) {
	return 0, fmt.Errorf("telegram send failed")
}

// noChannelNotifier simulates a notifier that is configured but has no active
// recipients (e.g. WebPush with no subscriptions).
type noChannelNotifier struct{}

func (n *noChannelNotifier) Send(_ context.Context, _ int64, _ notifier.Notification) (int, error) {
	return 0, notifier.ErrNoDeliveryChannel
}
func (n *noChannelNotifier) Delete(_ context.Context, _ int64, _ int) error { return nil }
func (n *noChannelNotifier) CloseNotification(_ context.Context, _ int64, _ string) error {
	return nil
}

func (f *failingNotifier) Delete(_ context.Context, _ int64, _ int) error { return nil }
func (f *failingNotifier) CloseNotification(_ context.Context, _ int64, _ string) error {
	return nil
}

func TestTZPlanNotifier_SendFailure_ResetsToPending(t *testing.T) {
	ms := &mockTZPlanNotifierStore{
		plan: &store.TZTransitionPlan{
			ID:        5,
			OldTZ:     "UTC",
			NewTZ:     "Europe/Berlin",
			Status:    "PENDING_APPROVAL",
			CreatedAt: time.Now(),
		},
		markNotifiedOK: true,
	}
	fn := &failingNotifier{}
	notif := &TZPlanNotifier{
		NotifyHelper: NotifyHelper{
			notifiers:     []notifier.Notifier{fn},
			allowedUserID: 42,
		},
		store: ms,
	}

	err := notif.Check(context.Background())
	if err == nil {
		t.Error("expected error when notification send fails")
	}
	if ms.resetToPendingID != 5 {
		t.Errorf("expected ResetPlanToPending called with plan ID 5, got %d", ms.resetToPendingID)
	}
}

func TestTZPlanNotifier_NoNotifiersConfigured_CancelsPlan(t *testing.T) {
	// With no notifiers in the slice (web-only deployment without WebPush) the
	// plan can never be delivered. Cancel it so the medication scheduler picks
	// up the new timezone immediately rather than pinning to OldTZ for 72h
	// until the PENDING_APPROVAL safety-net auto-approval kicks in.
	ms := &mockTZPlanNotifierStore{
		plan: &store.TZTransitionPlan{
			ID:        8,
			OldTZ:     "UTC",
			NewTZ:     "Europe/Berlin",
			Status:    "PENDING_APPROVAL",
			CreatedAt: time.Now(),
		},
	}
	notif := &TZPlanNotifier{
		NotifyHelper: NotifyHelper{
			notifiers:     nil,
			allowedUserID: 42,
		},
		store: ms,
	}

	if err := notif.Check(context.Background()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ms.updatedPlanID != 8 {
		t.Errorf("expected UpdateTZTransitionPlanStatus called with plan ID 8, got %d", ms.updatedPlanID)
	}
	if ms.updatedStatus != "CANCELLED" {
		t.Errorf("expected plan to be CANCELLED, got %q", ms.updatedStatus)
	}
	if ms.updatedUserAction != "no-notifiers-configured" {
		t.Errorf("expected user_action 'no-notifiers-configured', got %q", ms.updatedUserAction)
	}
	// Guard must be PENDING_APPROVAL so a concurrent web-banner approve/reject
	// that wins the race isn't clobbered by CANCELLED.
	if ms.updatedExpectedState != "PENDING_APPROVAL" {
		t.Errorf("expected expectedStatus 'PENDING_APPROVAL', got %q", ms.updatedExpectedState)
	}
	// MarkPlanNotified must not be called when the plan is cancelled upfront.
	if ms.markNotifiedID != 0 {
		t.Errorf("expected MarkPlanNotified not called, got plan ID %d", ms.markNotifiedID)
	}
}

func TestTZPlanNotifier_NoDeliveryChannel_CancelsPlan(t *testing.T) {
	// When all notifiers return ErrNoDeliveryChannel, the plan must be cancelled
	// so the medication scheduler uses the new timezone immediately — consistent
	// with the no-notifiers path where no plan is generated at all.
	ms := &mockTZPlanNotifierStore{
		plan: &store.TZTransitionPlan{
			ID:        6,
			OldTZ:     "UTC",
			NewTZ:     "Europe/Berlin",
			Status:    "PENDING_APPROVAL",
			CreatedAt: time.Now(),
		},
		markNotifiedOK: true,
	}
	nc := &noChannelNotifier{}
	notif := &TZPlanNotifier{
		NotifyHelper: NotifyHelper{
			notifiers:     []notifier.Notifier{nc},
			allowedUserID: 42,
		},
		store: ms,
	}

	err := notif.Check(context.Background())
	if err != nil {
		t.Errorf("ErrNoDeliveryChannel should not propagate as error, got: %v", err)
	}
	if ms.updatedPlanID != 6 {
		t.Errorf("expected UpdateTZTransitionPlanStatus called with plan ID 6, got %d", ms.updatedPlanID)
	}
	if ms.updatedStatus != "CANCELLED" {
		t.Errorf("expected plan to be CANCELLED, got %q", ms.updatedStatus)
	}
	if ms.updatedUserAction != "no-delivery-channel" {
		t.Errorf("expected user_action 'no-delivery-channel', got %q", ms.updatedUserAction)
	}
	// MarkPlanNotified moved the plan to NOTIFIED before the send attempt, so
	// the guard must be "NOTIFIED" — otherwise a concurrent web-banner approval
	// (which accepts NOTIFIED) could be clobbered by CANCELLED.
	if ms.updatedExpectedState != "NOTIFIED" {
		t.Errorf("expected expectedStatus 'NOTIFIED', got %q", ms.updatedExpectedState)
	}
}
