package bot

import (
	"fmt"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

// TestHandleCallback_ConfirmScheduleAcrossTimezones is the regression for the
// "✅ All medications for this time marked as taken." silent no-op the user
// reported. The intake row's scheduled_at is in the user's TZ
// (America/Los_Angeles), but the bot binary runs in a different time.Local
// (mimicked here via UTC). Tapping Confirm ALL produces a callback whose
// timestamp `time.Unix(ts,0)` lands in the bot's local zone — under the old
// store query, `WHERE scheduled_at = ?` matched zero rows and the bot still
// claimed success while the row stayed PENDING.
func TestHandleCallback_ConfirmScheduleAcrossTimezones(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()
	env.b.timezone = env.s.TZ

	if err := env.s.TZ.Record("America/Los_Angeles"); err != nil {
		t.Fatalf("Record: %v", err)
	}

	medID, err := env.s.Medication.Create("Candecor", "16mg",
		`{"type":"daily","times":["21:30"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	la, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatalf("LoadLocation: %v", err)
	}
	scheduledAt := time.Date(2026, 5, 5, 21, 30, 0, 0, la)
	intakeID, err := env.s.Medication.CreateIntake(medID, env.b.allowedUserID, scheduledAt)
	if err != nil {
		t.Fatalf("CreateIntake: %v", err)
	}

	// Build the callback exactly the way the scheduler does: encode the
	// schedule's Unix epoch. The bot will reconstruct it via time.Unix(ts,0)
	// and that result lives in the binary's time.Local — which on this CI
	// runner is unlikely to be America/Los_Angeles.
	cb := &tgbotapi.CallbackQuery{
		ID:   "cb_confirm_schedule_1",
		Data: fmt.Sprintf("confirm_schedule:%d", scheduledAt.Unix()),
		From: &tgbotapi.User{ID: env.b.allowedUserID},
		Message: &tgbotapi.Message{
			MessageID: 11,
			Chat:      &tgbotapi.Chat{ID: env.b.allowedUserID},
		},
	}

	env.b.handleCallback(cb)

	intake, err := env.s.Medication.GetIntake(intakeID)
	if err != nil {
		t.Fatalf("GetIntake: %v", err)
	}
	if intake == nil {
		t.Fatal("intake disappeared")
	}
	if intake.Status != "TAKEN" {
		t.Fatalf("expected status TAKEN after cross-TZ Confirm ALL, got %q", intake.Status)
	}
}

func TestHandleCallback_SkipIntake(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	medID, err := env.s.Medication.Create("Magnesium", "200mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	if err := env.s.Medication.SetSupplement(medID, true); err != nil {
		t.Fatalf("SetSupplement failed: %v", err)
	}

	scheduledAt := time.Now().Add(-2 * time.Hour).Truncate(time.Minute)
	intakeID, err := env.s.Medication.CreateIntake(medID, 123456, scheduledAt)
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

	intake, err := env.s.Medication.GetIntake(intakeID)
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

	medID, err := env.s.Medication.Create("Aspirin", "100mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	scheduledAt := time.Now().Add(-2 * time.Hour).Truncate(time.Minute)
	intakeID, err := env.s.Medication.CreateIntake(medID, 123456, scheduledAt)
	if err != nil {
		t.Fatalf("CreateIntake failed: %v", err)
	}

	// Confirm the intake first so it's TAKEN
	if err := env.s.Medication.ConfirmIntake(intakeID, time.Now()); err != nil {
		t.Fatalf("ConfirmIntake failed: %v", err)
	}

	intake, _ := env.s.Medication.GetIntake(intakeID)
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

	intake, err = env.s.Medication.GetIntake(intakeID)
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

	medID, err := env.s.Medication.Create("Aspirin", "100mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	scheduledAt := time.Now().Add(-2 * time.Hour).Truncate(time.Minute)
	intakeID, err := env.s.Medication.CreateIntake(medID, 123456, scheduledAt)
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
	intake, err := env.s.Medication.GetIntake(intakeID)
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
	medID, err := env.s.Medication.Create("Aspirin", "100mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	scheduledAt := time.Now().Add(-1 * time.Hour).Truncate(time.Minute)
	intakeID, err := env.s.Medication.CreateIntake(medID, 123456, scheduledAt)
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

	intake, err := env.s.Medication.GetIntake(intakeID)
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
