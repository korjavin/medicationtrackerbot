package bot

import (
	"fmt"
	"strings"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

func TestHandleCallback_LogMedicationDeletesMessage(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	medID, err := env.s.Medication.CreateMedication("Allopurinol", "100mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	cbData := fmt.Sprintf("log:%d", medID)

	cb := &tgbotapi.CallbackQuery{
		ID:   "cb_log_1",
		Data: cbData,
		From: &tgbotapi.User{ID: 123456},
		Message: &tgbotapi.Message{
			MessageID: 88,
			Chat:      &tgbotapi.Chat{ID: 123456},
			ReplyMarkup: &tgbotapi.InlineKeyboardMarkup{InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{
				{
					tgbotapi.NewInlineKeyboardButtonData("Take Allopurinol", cbData),
				},
			}},
		},
	}

	// Wait briefly to clear channel before calling handler
	time.Sleep(10 * time.Millisecond)

	env.b.handleCallback(cb)

	// Check if DeleteMessage was called
	deleteFound := false
	for {
		select {
		case req := <-env.requestChan:
			if strings.Contains(req, "deleteMessage") && strings.Contains(req, "message_id=88") {
				deleteFound = true
			}
		default:
			goto CheckDone
		}
	}
CheckDone:
	if !deleteFound {
		t.Errorf("Expected DeleteMessage to be called for the selection message (MessageID 88) but it was not.")
	}
}
