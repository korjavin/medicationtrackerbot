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
		if err := env.s.SetWeightReminderEnabled(userID, true); err != nil {
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
				if strings.Contains(msg, expected.MessageContains) {
					sentMessage = expected.MessageContains
				} else {
					if sentMessage == "" {
						sentMessage = msg // keep something to show it sent wrong message
					}
				}
			case req := <-env.requestChan:
				if strings.Contains(req, "editMessageReplyMarkup") {
					removedButtons = true
				}
			case <-time.After(10 * time.Millisecond):
				break drainLoop
			}
		}

		if sentMessage != "" && expected.MessageContains != "" && strings.Contains(sentMessage, expected.MessageContains) {
			sentMessage = expected.MessageContains // normalize to expected to avoid noisy exact matches if it contains it
		} else if sentMessage == "" {
			// This happens if messageChan got no messages but we expect one, which means our sleep wasn't long enough or we drained it wrongly
			// Do nothing special, it's just empty
		}

		state, err := env.s.GetWeightReminderState(userID)
		if err != nil {
			t.Fatalf("Failed to get state: %v", err)
		}

		actual := callbackScenarioExpected{
			MessageContains: sentMessage,
		}

		if expected.RemovedButtons {
			actual.RemovedButtons = removedButtons
		}
		if expected.Snoozed {
			actual.Snoozed = state.SnoozedUntil != nil
		}
		if expected.DontBugMe {
			actual.DontBugMe = state.DontRemindUntil != nil
		}

		testharness.CompareJSON(t, expected, actual)
	})
}
