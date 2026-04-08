package bot

import (
	"strings"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// mockTZPlanCallbackStore implements TZPlanCallbackStore for testing.
type mockTZPlanCallbackStore struct {
	plan            *store.TZTransitionPlan
	approvedAt      *time.Time
	updatedID       int64
	updatedStatus   string
	updatedAction   string
	updatedExpected string
	approveErr      error
	updateErr       error
}

func (m *mockTZPlanCallbackStore) GetLatestActiveOrPendingTZTransitionPlan() (*store.TZTransitionPlan, error) {
	return m.plan, nil
}

func (m *mockTZPlanCallbackStore) SetTZTransitionPlanApproved(id int64, at time.Time) error {
	m.updatedID = id
	m.approvedAt = &at
	return m.approveErr
}

func (m *mockTZPlanCallbackStore) UpdateTZTransitionPlanStatus(id int64, newStatus, userAction, expectedStatus string) error {
	m.updatedID = id
	m.updatedStatus = newStatus
	m.updatedAction = userAction
	m.updatedExpected = expectedStatus
	return m.updateErr
}

func makeTZPlanCallbackQuery(planAction string, planID string) *tgbotapi.CallbackQuery {
	return &tgbotapi.CallbackQuery{
		ID:   "cb1",
		Data: planAction + ":" + planID,
		Message: &tgbotapi.Message{
			MessageID: 99,
			Chat:      &tgbotapi.Chat{ID: 123456},
		},
	}
}

func TestHandleTZPlanApprove_Success(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	ms := &mockTZPlanCallbackStore{}
	env.b.tzPlanStore = ms

	cb := makeTZPlanCallbackQuery("tz_plan_approve", "7")
	env.b.handleTZPlanApprove(cb, 7)

	if ms.updatedID != 7 {
		t.Errorf("expected plan ID 7 to be approved, got %d", ms.updatedID)
	}
	if ms.approvedAt == nil {
		t.Error("expected approvedAt to be set")
	}

	// Should send a confirmation message.
	select {
	case body := <-env.messageChan:
		if !strings.Contains(body, "approved") && !strings.Contains(body, "Approve") {
			t.Errorf("expected approval confirmation message, got: %s", body)
		}
	default:
		t.Error("expected a confirmation message to be sent")
	}
}

func TestHandleTZPlanReject_Success(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	ms := &mockTZPlanCallbackStore{}
	env.b.tzPlanStore = ms

	cb := makeTZPlanCallbackQuery("tz_plan_reject", "8")
	env.b.handleTZPlanReject(cb, 8)

	if ms.updatedID != 8 {
		t.Errorf("expected plan ID 8 to be rejected, got %d", ms.updatedID)
	}
	if ms.updatedStatus != "REJECTED" {
		t.Errorf("expected status REJECTED, got %q", ms.updatedStatus)
	}
	if ms.updatedAction != "rejected" {
		t.Errorf("expected user_action 'rejected', got %q", ms.updatedAction)
	}

	// Should send a confirmation message.
	select {
	case body := <-env.messageChan:
		if !strings.Contains(body, "reject") && !strings.Contains(body, "Reject") && !strings.Contains(body, "retained") {
			t.Errorf("expected rejection confirmation message, got: %s", body)
		}
	default:
		t.Error("expected a confirmation message to be sent")
	}
}

func TestHandleCallback_TZPlanApprove_Routing(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	ms := &mockTZPlanCallbackStore{}
	env.b.tzPlanStore = ms

	cb := &tgbotapi.CallbackQuery{
		ID:   "cb2",
		Data: "tz_plan_approve:42",
		Message: &tgbotapi.Message{
			MessageID: 10,
			Chat:      &tgbotapi.Chat{ID: 123456},
		},
	}
	env.b.handleCallback(cb)

	if ms.updatedID != 42 {
		t.Errorf("expected plan 42 approved via handleCallback, got %d", ms.updatedID)
	}
}

func TestHandleCallback_TZPlanReject_Routing(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	ms := &mockTZPlanCallbackStore{}
	env.b.tzPlanStore = ms

	cb := &tgbotapi.CallbackQuery{
		ID:   "cb3",
		Data: "tz_plan_reject:55",
		Message: &tgbotapi.Message{
			MessageID: 10,
			Chat:      &tgbotapi.Chat{ID: 123456},
		},
	}
	env.b.handleCallback(cb)

	if ms.updatedID != 55 {
		t.Errorf("expected plan 55 rejected via handleCallback, got %d", ms.updatedID)
	}
	if ms.updatedStatus != "REJECTED" {
		t.Errorf("expected REJECTED status, got %q", ms.updatedStatus)
	}
}
