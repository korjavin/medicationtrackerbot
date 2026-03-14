package bot

import (
	"fmt"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

func TestHandleCallback_SkipIntake(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	medID, err := env.s.CreateMedication("Magnesium", "200mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}
	if err := env.s.SetMedicationSupplement(medID, true); err != nil {
		t.Fatalf("SetMedicationSupplement failed: %v", err)
	}

	scheduledAt := time.Now().Add(-2 * time.Hour).Truncate(time.Minute)
	intakeID, err := env.s.CreateIntake(medID, 123456, scheduledAt)
	if err != nil {
		t.Fatalf("CreateIntake failed: %v", err)
	}

	confirmData := fmt.Sprintf("confirm_intake:%d", intakeID)
	skipData := fmt.Sprintf("skip_intake:%d", intakeID)

	cb := &tgbotapi.CallbackQuery{
		ID:   "cb_skip_1",
		Data: skipData,
		From: &tgbotapi.User{ID: 123456},
		Message: &tgbotapi.Message{
			MessageID: 77,
			Chat:      &tgbotapi.Chat{ID: 123456},
			ReplyMarkup: &tgbotapi.InlineKeyboardMarkup{InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{
				{
					tgbotapi.NewInlineKeyboardButtonData("Take Magnesium", confirmData),
					tgbotapi.NewInlineKeyboardButtonData("Skip Magnesium", skipData),
				},
			}},
		},
	}

	env.b.handleCallback(cb)

	intake, err := env.s.GetIntake(intakeID)
	if err != nil {
		t.Fatalf("GetIntake failed: %v", err)
	}
	if intake == nil {
		t.Fatal("expected intake, got nil")
	}
	if intake.Status != "SKIPPED" {
		t.Fatalf("expected SKIPPED status, got %q", intake.Status)
	}
}
