package bot

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/korjavin/medicationtrackerbot/internal/testharness"
)

func TestWeightCallbackScenarios(t *testing.T) {
	filename := filepath.Join("testdata", "weight_callback_scenarios.json")

	testharness.RunScenarios(t, filename, func(t *testing.T, s testharness.Scenario) {
		var input callbackScenarioInput
		if err := json.Unmarshal(s.Input, &input); err != nil {
			t.Fatalf("Failed to unmarshal input: %v", err)
		}

		var expected callbackScenarioExpected
		if err := json.Unmarshal(s.Expected, &expected); err != nil {
			t.Fatalf("Failed to unmarshal expected: %v", err)
		}

		env := setupBotTest(t)
		defer env.teardown()

		userID := int64(123456)
		if err := env.s.Weight.SetWeightReminderEnabled(userID, true); err != nil {
			t.Fatalf("SetWeightReminderEnabled failed: %v", err)
		}

		cb := &tgbotapi.CallbackQuery{
			ID:   "test_cb",
			Data: input.CallbackData,
			From: &tgbotapi.User{ID: userID},
			Message: &tgbotapi.Message{
				MessageID: 100,
				Chat:      &tgbotapi.Chat{ID: userID},
			},
		}

		env.b.handleWeightReminderCallback(cb, input.CallbackData)

		time.Sleep(50 * time.Millisecond)

		var sentMessage string
		removedButtons := false

	drainLoop:
		for {
			select {
			case msg := <-env.messageChan:
				if expected.MessageContains == "" {
					sentMessage = msg
				} else if strings.Contains(msg, expected.MessageContains) {
					sentMessage = expected.MessageContains
				} else if sentMessage == "" {
					sentMessage = msg
				}
			case req := <-env.requestChan:
				if strings.Contains(req, "editMessageReplyMarkup") {
					removedButtons = true
				}
			case <-time.After(10 * time.Millisecond):
				break drainLoop
			}
		}

		state, err := env.s.Weight.GetWeightReminderState(userID)
		if err != nil {
			t.Fatalf("Failed to get state: %v", err)
		}

		actual := callbackScenarioExpected{
			MessageContains: sentMessage,
			RemovedButtons:  removedButtons,
			Snoozed:         state.SnoozedUntil != nil,
			DontBugMe:       state.DontRemindUntil != nil,
		}

		testharness.CompareJSON(t, expected, actual)
	})
}
