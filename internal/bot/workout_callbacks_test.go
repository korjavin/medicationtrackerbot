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

type workoutCallbackScenarioExpected struct {
	MessageContains string `json:"message_contains"`
	Status          string `json:"status"`
	Snoozed         bool   `json:"snoozed"`
}

func TestWorkoutCallbackScenarios(t *testing.T) {
	filename := filepath.Join("testdata", "workout_callback_scenarios.json")

	testharness.RunScenarios(t, filename, func(t *testing.T, s testharness.Scenario) {
		var input callbackScenarioInput
		if err := json.Unmarshal(s.Input, &input); err != nil {
			t.Fatalf("Failed to unmarshal input: %v", err)
		}

		var expected workoutCallbackScenarioExpected
		if err := json.Unmarshal(s.Expected, &expected); err != nil {
			t.Fatalf("Failed to unmarshal expected: %v", err)
		}

		env := setupBotTest(t)
		defer env.teardown()

		userID := int64(123456)

		// Create session
		group, err := env.s.CreateWorkoutGroup("Test", "desc", false, userID, "[0,1,2,3,4,5,6]", "09:00", 15)
		if err != nil {
			t.Fatalf("CreateWorkoutGroup: %v", err)
		}

		order := 0
		variant, err := env.s.CreateWorkoutVariant(group.ID, "A", &order, "")
		if err != nil {
			t.Fatalf("CreateWorkoutVariant: %v", err)
		}

		session, err := env.s.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "09:00")
		if err != nil {
			t.Fatalf("CreateWorkoutSession: %v", err)
		}

		// Since we use in-memory sqlite, the first session is always ID=1.
		// The json file hardcodes `_1`.
		inputData := input.CallbackData

		cb := &tgbotapi.CallbackQuery{
			ID:   "test_cb",
			Data: inputData,
			From: &tgbotapi.User{ID: userID},
			Message: &tgbotapi.Message{
				MessageID: 100,
				Chat:      &tgbotapi.Chat{ID: userID},
			},
		}

		env.b.handleWorkoutCallback(cb, inputData)

		time.Sleep(50 * time.Millisecond)

		var sentMessage string

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
			case <-time.After(10 * time.Millisecond):
				break drainLoop
			}
		}

		if sentMessage != "" && expected.MessageContains != "" && strings.Contains(sentMessage, expected.MessageContains) {
			sentMessage = expected.MessageContains // normalize to expected to avoid noisy exact matches if it contains it
		} else if sentMessage == "" {
			// fallback
		}

		updatedSession, err := env.s.GetWorkoutSession(session.ID)
		if err != nil {
			t.Fatalf("Failed to get session: %v", err)
		}

		actual := workoutCallbackScenarioExpected{
			MessageContains: sentMessage,
			Status:          updatedSession.Status,
		}

		if expected.Snoozed {
			actual.Snoozed = updatedSession.SnoozedUntil != nil
		}
		testharness.CompareJSON(t, expected, actual)
	})
}
