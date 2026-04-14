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

	medID, err := env.s.CreateMedication("Magnesium", "200mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
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

func TestHandleCallback_CancelIntake(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	medID, err := env.s.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	scheduledAt := time.Now().Add(-2 * time.Hour).Truncate(time.Minute)
	intakeID, err := env.s.CreateIntake(medID, 123456, scheduledAt)
	if err != nil {
		t.Fatalf("CreateIntake failed: %v", err)
	}

	// Confirm the intake first so it's TAKEN
	if err := env.s.ConfirmIntake(intakeID, time.Now()); err != nil {
		t.Fatalf("ConfirmIntake failed: %v", err)
	}

	intake, _ := env.s.GetIntake(intakeID)
	if intake.Status != "TAKEN" {
		t.Fatalf("expected TAKEN status before cancel, got %q", intake.Status)
	}

	cancelData := fmt.Sprintf("cancel_intake:%d", intakeID)
	cb := &tgbotapi.CallbackQuery{
		ID:   "cb_cancel_1",
		Data: cancelData,
		From: &tgbotapi.User{ID: 123456},
		Message: &tgbotapi.Message{
			MessageID: 99,
			Chat:      &tgbotapi.Chat{ID: 123456},
		},
	}

	env.b.handleCallback(cb)

	intake, err = env.s.GetIntake(intakeID)
	if err != nil {
		t.Fatalf("GetIntake failed: %v", err)
	}
	if intake == nil {
		t.Fatal("expected intake, got nil")
	}
	if intake.Status != "PENDING" {
		t.Fatalf("expected PENDING status after cancel, got %q", intake.Status)
	}
}

func TestHandleCallback_CancelIntake_AlreadyPending(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	medID, err := env.s.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	scheduledAt := time.Now().Add(-2 * time.Hour).Truncate(time.Minute)
	intakeID, err := env.s.CreateIntake(medID, 123456, scheduledAt)
	if err != nil {
		t.Fatalf("CreateIntake failed: %v", err)
	}

	// Intake is PENDING — cancel should produce "No intakes to cancel" message
	cancelData := fmt.Sprintf("cancel_intake:%d", intakeID)
	cb := &tgbotapi.CallbackQuery{
		ID:   "cb_cancel_pending",
		Data: cancelData,
		From: &tgbotapi.User{ID: 123456},
		Message: &tgbotapi.Message{
			MessageID: 99,
			Chat:      &tgbotapi.Chat{ID: 123456},
		},
	}

	env.b.handleCallback(cb)

	// Intake should remain PENDING
	intake, err := env.s.GetIntake(intakeID)
	if err != nil {
		t.Fatalf("GetIntake failed: %v", err)
	}
	if intake.Status != "PENDING" {
		t.Fatalf("expected PENDING status unchanged, got %q", intake.Status)
	}
}

func TestHandleCallback_SkipIntake_NonSupplement(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	// Non-supplement medication: skip must work since the supplement restriction was removed
	medID, err := env.s.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	scheduledAt := time.Now().Add(-1 * time.Hour).Truncate(time.Minute)
	intakeID, err := env.s.CreateIntake(medID, 123456, scheduledAt)
	if err != nil {
		t.Fatalf("CreateIntake failed: %v", err)
	}

	confirmData := fmt.Sprintf("confirm_intake:%d", intakeID)
	skipData := fmt.Sprintf("skip_intake:%d", intakeID)

	cb := &tgbotapi.CallbackQuery{
		ID:   "cb_skip_nonsuppl",
		Data: skipData,
		From: &tgbotapi.User{ID: 123456},
		Message: &tgbotapi.Message{
			MessageID: 88,
			Chat:      &tgbotapi.Chat{ID: 123456},
			ReplyMarkup: &tgbotapi.InlineKeyboardMarkup{InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{
				{
					tgbotapi.NewInlineKeyboardButtonData("Take Aspirin", confirmData),
					tgbotapi.NewInlineKeyboardButtonData("Skip Aspirin", skipData),
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
		t.Fatalf("expected SKIPPED status for non-supplement, got %q", intake.Status)
	}
}
