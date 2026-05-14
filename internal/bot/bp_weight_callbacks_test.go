package bot

import (
	"strings"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

// sendCallback dispatches a callback query to the bot and waits for the first
// sendMessage response (if any). Returns "" if no sendMessage arrives within 1s.
func sendCallback(env *botTestEnv, data string) string {
	cb := &tgbotapi.CallbackQuery{
		ID:   "test-cb-id",
		From: &tgbotapi.User{ID: 123456},
		Message: &tgbotapi.Message{
			MessageID: 100,
			Chat:      &tgbotapi.Chat{ID: 123456},
		},
		Data: data,
	}
	env.b.handleCallback(cb)
	select {
	case body := <-env.messageChan:
		return body
	case <-time.After(1 * time.Second):
		return ""
	}
}

// --- bp_callbacks.go ---

func TestBPCallback_Snooze_UpdatesStore(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	if err := env.s.BP.SetBPReminderEnabled(123456, true); err != nil {
		t.Fatalf("SetBPReminderEnabled: %v", err)
	}

	// Send the bp_snooze callback
	body := sendCallback(env, "bp_snooze")
	if body == "" {
		t.Fatal("Timeout waiting for snooze confirmation message")
	}
	if !strings.Contains(body, "snoozed") {
		t.Errorf("Expected snooze confirmation, got: %s", body)
	}

	// Verify snooze was recorded in the store
	state, err := env.s.BP.GetBPReminderState(123456)
	if err != nil {
		t.Fatalf("GetBPReminderState: %v", err)
	}
	if state.SnoozedUntil == nil {
		t.Error("Expected SnoozedUntil to be set after bp_snooze callback")
	}
}

func TestBPCallback_DontBugMe_UpdatesStore(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	if err := env.s.BP.SetBPReminderEnabled(123456, true); err != nil {
		t.Fatalf("SetBPReminderEnabled: %v", err)
	}

	body := sendCallback(env, "bp_dontbug")
	if body == "" {
		t.Fatal("Timeout waiting for dontbug confirmation message")
	}
	if !strings.Contains(body, "disabled") {
		t.Errorf("Expected 'disabled' in response, got: %s", body)
	}

	state, err := env.s.BP.GetBPReminderState(123456)
	if err != nil {
		t.Fatalf("GetBPReminderState: %v", err)
	}
	if state.DontRemindUntil == nil {
		t.Error("Expected DontRemindUntil to be set after bp_dontbug callback")
	}
}

func TestBPCallback_Confirm_SendsLink(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	body := sendCallback(env, "bp_confirm")
	if body == "" {
		t.Fatal("Timeout waiting for bp_confirm response")
	}
	// Should contain a link to open the app
	if !strings.Contains(body, "bp") {
		t.Errorf("Expected BP link in confirm response, got: %s", body)
	}
}

// --- weight_callbacks.go ---

func TestWeightCallback_Snooze_UpdatesStore(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	if err := env.s.Weight.SetWeightReminderEnabled(123456, true); err != nil {
		t.Fatalf("SetWeightReminderEnabled: %v", err)
	}

	body := sendCallback(env, "weight_snooze")
	if body == "" {
		t.Fatal("Timeout waiting for weight snooze confirmation")
	}
	if !strings.Contains(body, "snoozed") {
		t.Errorf("Expected snooze confirmation, got: %s", body)
	}

	state, err := env.s.Weight.GetWeightReminderState(123456)
	if err != nil {
		t.Fatalf("GetWeightReminderState: %v", err)
	}
	if state.SnoozedUntil == nil {
		t.Error("Expected SnoozedUntil to be set after weight_snooze callback")
	}
}

func TestWeightCallback_DontBugMe_UpdatesStore(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	if err := env.s.Weight.SetWeightReminderEnabled(123456, true); err != nil {
		t.Fatalf("SetWeightReminderEnabled: %v", err)
	}

	body := sendCallback(env, "weight_dontbug")
	if body == "" {
		t.Fatal("Timeout waiting for weight dontbug confirmation")
	}
	if !strings.Contains(body, "disabled") {
		t.Errorf("Expected 'disabled' in response, got: %s", body)
	}

	state, err := env.s.Weight.GetWeightReminderState(123456)
	if err != nil {
		t.Fatalf("GetWeightReminderState: %v", err)
	}
	if state.DontRemindUntil == nil {
		t.Error("Expected DontRemindUntil to be set after weight_dontbug callback")
	}
}

func TestWeightCallback_Confirm_SendsLink(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	body := sendCallback(env, "weight_confirm")
	if body == "" {
		t.Fatal("Timeout waiting for weight_confirm response")
	}
	if !strings.Contains(body, "weight") {
		t.Errorf("Expected weight link in confirm response, got: %s", body)
	}
}
