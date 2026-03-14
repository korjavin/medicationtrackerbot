package bot

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

// TestDeleteMessageUsesRequest verifies that when the bot deletes reminder
// messages after intake confirmation, it uses b.api.Request() (not Send()),
// so the Telegram "true" response doesn't cause a JSON unmarshal error.
//
// The real Telegram API returns {"ok":true,"result":true} for deleteMessage,
// and bot.Send() tries to unmarshal "true" into tgbotapi.Message, which fails.
// The production symptom: "json: cannot unmarshal bool into Go value of type
// tgbotapi.Message" errors in logs, and reminder messages NOT deleted.
func TestDeleteMessageUsesRequest(t *testing.T) {
	var deleteCalls []string

	env := setupBotTestCustom(t, func(path, body string) string {
		if strings.Contains(path, "deleteMessage") {
			deleteCalls = append(deleteCalls, path+"|"+body)
			// Real Telegram response: result is boolean true, not a Message object
			return `{"ok":true,"result":true}`
		}
		// Default: return a Message-shaped response for sendMessage / answerCallbackQuery / editMessageReplyMarkup
		return `{"ok":true,"result":{"message_id":123,"chat":{"id":123456}}}`
	})
	defer env.teardown()

	// Set up: create medication + intake + reminder record
	medID, err := env.s.CreateMedication("Candecor", "16mg", `{"type":"daily","times":["21:30"]}`, nil, nil, "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	scheduledAt := time.Date(2026, 3, 11, 21, 30, 0, 0, time.UTC)
	intakeID, err := env.s.CreateIntake(medID, 123456, scheduledAt)
	if err != nil {
		t.Fatalf("CreateIntake failed: %v", err)
	}

	// Simulate: a reminder message was sent (msgID=500) and stored in DB
	reminderMsgID := 500
	if err := env.s.AddIntakeReminder(intakeID, reminderMsgID); err != nil {
		t.Fatalf("AddIntakeReminder failed: %v", err)
	}

	// Trigger confirm_intake callback from message 501 (different from reminder 500)
	cb := &tgbotapi.CallbackQuery{
		ID:   "cb_confirm_1",
		Data: fmt.Sprintf("confirm_intake:%d", intakeID),
		From: &tgbotapi.User{ID: 123456},
		Message: &tgbotapi.Message{
			MessageID: 501, // different from the stored reminder (500)
			Chat:      &tgbotapi.Chat{ID: 123456},
			ReplyMarkup: &tgbotapi.InlineKeyboardMarkup{
				InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{
					{tgbotapi.NewInlineKeyboardButtonData("✅ Confirm Intake", fmt.Sprintf("confirm_intake:%d", intakeID))},
				},
			},
		},
	}

	env.b.handleCallback(cb)

	// Verify the delete call was made
	if len(deleteCalls) == 0 {
		t.Fatal("expected deleteMessage to be called for the stored reminder, but it wasn't")
	}

	// Verify the correct message was targeted for deletion
	found := false
	for _, call := range deleteCalls {
		if strings.Contains(call, fmt.Sprintf("message_id=%d", reminderMsgID)) {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("deleteMessage was not called with the stored reminder message ID %d; calls: %v", reminderMsgID, deleteCalls)
	}

	// Most importantly: the callback handling should NOT have errored out
	// (if it used Send() instead of Request(), the JSON parse error would
	// prevent the rest of the cleanup from happening or cause a panic in tests)
	intake, err := env.s.GetIntake(intakeID)
	if err != nil {
		t.Fatalf("GetIntake failed: %v", err)
	}
	if intake.Status != "TAKEN" {
		t.Errorf("expected intake status TAKEN, got %q", intake.Status)
	}
}

func TestDeleteMessagesParallel_PartialFailure(t *testing.T) {
	deleteCalls := make(map[string]int)
	var mu sync.Mutex

	env := setupBotTestCustom(t, func(path, body string) string {
		if strings.Contains(path, "deleteMessage") {
			mu.Lock()
			deleteCalls[body]++
			count := deleteCalls[body]
			mu.Unlock()

			// Simulate rate limit for the first attempt of message 1001
			if strings.Contains(body, "message_id=1001") && count == 1 {
				return `{"ok":false,"error_code":429,"description":"Too Many Requests"}`
			}
			return `{"ok":true,"result":true}`
		}
		return `{"ok":true,"result":{"message_id":123,"chat":{"id":123456}}}`
	})
	defer env.teardown()

	msgIDs := []int{1000, 1001, 1002, 1003, 1004}
	chatID := int64(123456)

	// This should not panic and should complete even with partial failures
	env.b.deleteMessagesParallel(chatID, msgIDs, 0)

	mu.Lock()
	defer mu.Unlock()

	// Verify all messages were attempted
	for _, id := range msgIDs {
		bodyPart := fmt.Sprintf("message_id=%d", id)
		found := false
		for body := range deleteCalls {
			if strings.Contains(body, bodyPart) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("message %d was not attempted", id)
		}
	}
}
