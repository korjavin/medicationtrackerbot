package bot

import (
	"strings"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

// mockTZPlanCallbackStore implements TZPlanCallbackStore for testing.
type mockTZPlanCallbackStore struct {
	approvedAt  *time.Time
	updatedID   int64
	rejectedID  int64
	approveErr  error
	rejectErr   error
}

func (m *mockTZPlanCallbackStore) SetTZTransitionPlanApproved(id int64, at time.Time) (bool, error) {
	m.updatedID = id
	m.approvedAt = &at
	return m.approveErr == nil, m.approveErr
}

func (m *mockTZPlanCallbackStore) RejectTZTransitionPlanAndRevertTimezone(id int64) (bool, error) {
	m.updatedID = id
	m.rejectedID = id
	return m.rejectErr == nil, m.rejectErr
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

	if ms.rejectedID != 8 {
		t.Errorf("expected plan ID 8 to be rejected, got %d", ms.rejectedID)
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

	if ms.rejectedID != 55 {
		t.Errorf("expected plan 55 rejected via handleCallback, got %d", ms.rejectedID)
	}
}

// mockTZPlanCallbackStoreNoRows simulates store methods that affect 0 rows (stale callback).
type mockTZPlanCallbackStoreNoRows struct{}

func (m *mockTZPlanCallbackStoreNoRows) SetTZTransitionPlanApproved(id int64, at time.Time) (bool, error) {
	return false, nil
}

func (m *mockTZPlanCallbackStoreNoRows) RejectTZTransitionPlanAndRevertTimezone(id int64) (bool, error) {
	return false, nil
}

func TestHandleTZPlanApprove_StaleCallback(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	env.b.tzPlanStore = &mockTZPlanCallbackStoreNoRows{}

	cb := makeTZPlanCallbackQuery("tz_plan_approve", "99")
	env.b.handleTZPlanApprove(cb, 99)

	select {
	case body := <-env.messageChan:
		if !strings.Contains(body, "no longer active") && !strings.Contains(body, "longer active") {
			t.Errorf("expected 'no longer active' message for stale callback, got: %s", body)
		}
	default:
		t.Error("expected a message to be sent for stale approve callback")
	}
}

func TestHandleTZPlanReject_StaleCallback(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	env.b.tzPlanStore = &mockTZPlanCallbackStoreNoRows{}

	cb := makeTZPlanCallbackQuery("tz_plan_reject", "99")
	env.b.handleTZPlanReject(cb, 99)

	select {
	case body := <-env.messageChan:
		if !strings.Contains(body, "no longer active") && !strings.Contains(body, "longer active") {
			t.Errorf("expected 'no longer active' message for stale callback, got: %s", body)
		}
	default:
		t.Error("expected a message to be sent for stale reject callback")
	}
}
