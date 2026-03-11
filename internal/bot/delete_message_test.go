package bot

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/korjavin/medicationtrackerbot/internal/domain"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	workoutsvc "github.com/korjavin/medicationtrackerbot/internal/workout"
)

// setupBotTestCustom sets up a bot test environment with a custom per-endpoint
// handler, useful for simulating specific Telegram API responses (e.g. the
// boolean "true" returned by deleteMessage).
func setupBotTestCustom(t *testing.T, handler func(path, body string) string) *botTestEnv {
	t.Helper()
	s, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create store: %v", err)
	}

	messageChan := make(chan string, 100)
	requestChan := make(chan string, 100)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bodyBytes, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("Failed to read request body: %v", err)
			return
		}
		bodyStr, err := url.QueryUnescape(string(bodyBytes))
		if err != nil {
			t.Errorf("Failed to unescape URL: %v", err)
			return
		}

		requestChan <- r.URL.Path + "|" + bodyStr

		if strings.Contains(r.URL.Path, "sendMessage") {
			messageChan <- bodyStr
		}

		resp := handler(r.URL.Path, bodyStr)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(resp))
	}))

	api := &tgbotapi.BotAPI{
		Token:  "TEST_TOKEN",
		Client: &http.Client{},
		Buffer: 100,
	}
	api.SetAPIEndpoint(server.URL + "/bot%s/%s")

	b := &Bot{
		api:           api,
		meds:          s,
		medSvc:        domain.NewMedicationService(s),
		bp:            s,
		weight:        s,
		workouts:      s,
		workoutSvc:    workoutsvc.New(s),
		exerciseSvc:   domain.NewExerciseService(s),
		reminderSvc:   domain.NewReminderService(s),
		food:          s,
		imports:       s,
		allowedUserID: 123456,
	}

	return &botTestEnv{
		b:           b,
		s:           s,
		server:      server,
		messageChan: messageChan,
		requestChan: requestChan,
	}
}

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
