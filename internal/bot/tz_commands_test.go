package bot

import (
	"errors"
	"strings"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

type mockTimezoneStore struct {
	currentTZ  string
	currentErr error
}

func (m *mockTimezoneStore) GetCurrent() (string, error) {
	return m.currentTZ, m.currentErr
}

func TestHandleTZCommand_SendsLocationKeyboard(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	env.b.timezone = &mockTimezoneStore{}

	msg := &tgbotapi.Message{
		Chat: &tgbotapi.Chat{ID: 123},
		Text: "/tz",
		Entities: []tgbotapi.MessageEntity{
			{Type: "bot_command", Offset: 0, Length: 3},
		},
		From: &tgbotapi.User{ID: 123456},
	}

	env.b.handleMessage(msg)

	select {
	case body := <-env.messageChan:
		if !strings.Contains(body, "location") && !strings.Contains(body, "Location") {
			t.Errorf("Expected location keyboard in response, got: %q", body)
		}
	default:
		t.Fatal("Expected a message to be sent, but none was")
	}
}

func TestHandleLocationMessage_RecordsTZ(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	mu := &mockTZUpdater{}
	env.b.tzUpdater = mu

	// Simulate user having invoked /tz first
	env.b.awaitingLocationChatID = 123
	env.b.awaitingLocationExpiry = time.Now().Add(time.Hour)

	// 52.52, 13.40 is Berlin → Europe/Berlin
	msg := &tgbotapi.Message{
		Chat: &tgbotapi.Chat{ID: 123},
		Location: &tgbotapi.Location{
			Latitude:  52.52,
			Longitude: 13.40,
		},
		From: &tgbotapi.User{ID: 123456},
	}

	env.b.handleMessage(msg)

	calls := mu.recordedCalls()
	if len(calls) != 1 {
		t.Fatalf("Expected 1 UpdateTimezone call, got %d", len(calls))
	}
	if calls[0] != "Europe/Berlin" {
		t.Errorf("Expected Europe/Berlin, got %q", calls[0])
	}

	select {
	case body := <-env.messageChan:
		if !strings.Contains(body, "Europe/Berlin") {
			t.Errorf("Expected confirmation message with timezone, got: %q", body)
		}
	default:
		t.Fatal("Expected a confirmation message, but none was sent")
	}
}

func TestHandleLocationMessage_StoreError(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	mu := &mockTZUpdater{err: errors.New("db error")}
	env.b.tzUpdater = mu

	// Simulate user having invoked /tz first
	env.b.awaitingLocationChatID = 123
	env.b.awaitingLocationExpiry = time.Now().Add(time.Hour)

	msg := &tgbotapi.Message{
		Chat: &tgbotapi.Chat{ID: 123},
		Location: &tgbotapi.Location{
			Latitude:  52.52,
			Longitude: 13.40,
		},
		From: &tgbotapi.User{ID: 123456},
	}

	env.b.handleMessage(msg)

	select {
	case body := <-env.messageChan:
		if !strings.Contains(body, "Error") && !strings.Contains(body, "error") {
			t.Errorf("Expected error message, got: %q", body)
		}
	default:
		t.Fatal("Expected an error message, but none was sent")
	}

	// Even though UpdateTimezone failed, the call should still have been recorded.
	if calls := mu.recordedCalls(); len(calls) != 1 {
		t.Errorf("Expected exactly 1 UpdateTimezone call (which returned error), got %d", len(calls))
	}
}

func TestHandleLocationMessage_PlanCreated_MessageMentionsApprovalPrompt(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	mu := &mockTZUpdater{planCreated: true}
	env.b.tzUpdater = mu

	env.b.awaitingLocationChatID = 123
	env.b.awaitingLocationExpiry = time.Now().Add(time.Hour)

	msg := &tgbotapi.Message{
		Chat: &tgbotapi.Chat{ID: 123},
		Location: &tgbotapi.Location{
			Latitude:  52.52,
			Longitude: 13.40,
		},
		From: &tgbotapi.User{ID: 123456},
	}

	env.b.handleMessage(msg)

	select {
	case body := <-env.messageChan:
		if !strings.Contains(body, "Europe/Berlin") {
			t.Errorf("Expected message to contain new timezone, got: %q", body)
		}
		if !strings.Contains(body, "transition plan") {
			t.Errorf("Expected message to reference the transition plan, got: %q", body)
		}
		if !strings.Contains(body, "approve") && !strings.Contains(body, "reject") {
			t.Errorf("Expected message to reference approval/rejection, got: %q", body)
		}
		if strings.Contains(body, "medication times are not affected") {
			t.Errorf("Confirmation must not contain the old (false) disclaimer, got: %q", body)
		}
	default:
		t.Fatal("Expected a confirmation message, but none was sent")
	}
}

func TestHandleLocationMessage_NoPlan_MessageDoesNotMentionPrompt(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	mu := &mockTZUpdater{planCreated: false}
	env.b.tzUpdater = mu

	env.b.awaitingLocationChatID = 123
	env.b.awaitingLocationExpiry = time.Now().Add(time.Hour)

	msg := &tgbotapi.Message{
		Chat: &tgbotapi.Chat{ID: 123},
		Location: &tgbotapi.Location{
			Latitude:  52.52,
			Longitude: 13.40,
		},
		From: &tgbotapi.User{ID: 123456},
	}

	env.b.handleMessage(msg)

	select {
	case body := <-env.messageChan:
		if !strings.Contains(body, "Europe/Berlin") {
			t.Errorf("Expected message to contain timezone, got: %q", body)
		}
		if !strings.Contains(body, "Workout") && !strings.Contains(body, "workout") {
			t.Errorf("Expected message to mention adjusted reminders, got: %q", body)
		}
		if strings.Contains(body, "transition plan") {
			t.Errorf("No-plan branch must not reference a transition plan, got: %q", body)
		}
		if strings.Contains(body, "approve") || strings.Contains(body, "reject") {
			t.Errorf("No-plan branch must not reference approval/rejection, got: %q", body)
		}
		if strings.Contains(body, "medication times are not affected") {
			t.Errorf("Confirmation must not contain the old (false) disclaimer, got: %q", body)
		}
	default:
		t.Fatal("Expected a confirmation message, but none was sent")
	}
}

func TestHandleLocationMessage_IgnoredWithoutTZCommand(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	mu := &mockTZUpdater{}
	env.b.tzUpdater = mu

	// No /tz command issued — awaitingLocation is false
	msg := &tgbotapi.Message{
		Chat: &tgbotapi.Chat{ID: 123},
		Location: &tgbotapi.Location{
			Latitude:  52.52,
			Longitude: 13.40,
		},
		From: &tgbotapi.User{ID: 123456},
	}

	env.b.handleMessage(msg)

	if calls := mu.recordedCalls(); len(calls) != 0 {
		t.Errorf("Expected no UpdateTimezone calls for unsolicited location, got %d", len(calls))
	}
	select {
	case body := <-env.messageChan:
		t.Errorf("Expected no message for unsolicited location, got: %q", body)
	default:
		// correct — no message sent
	}
}

func TestHandleLocationMessage_InvalidCoords(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	mu := &mockTZUpdater{}
	env.b.tzUpdater = mu

	// Simulate user having invoked /tz first
	env.b.awaitingLocationChatID = 123
	env.b.awaitingLocationExpiry = time.Now().Add(time.Hour)

	// Middle of the ocean — no timezone
	msg := &tgbotapi.Message{
		Chat: &tgbotapi.Chat{ID: 123},
		Location: &tgbotapi.Location{
			Latitude:  0.0,
			Longitude: -30.0,
		},
		From: &tgbotapi.User{ID: 123456},
	}

	env.b.handleMessage(msg)

	// Should send some message (either error or a valid ocean tz)
	select {
	case body := <-env.messageChan:
		calls := mu.recordedCalls()
		if len(calls) == 0 {
			// No timezone found - should be an error/retry message
			if !strings.Contains(body, "not") && !strings.Contains(body, "error") && !strings.Contains(body, "Error") && !strings.Contains(body, "Could not") {
				t.Errorf("Expected error message for no-timezone case, got: %q", body)
			}
		} else {
			// Timezone was found - confirmation should contain the tz name
			if !strings.Contains(body, calls[0]) {
				t.Errorf("Expected confirmation with tz %q, got: %q", calls[0], body)
			}
		}
	default:
		t.Fatal("Expected a message to be sent")
	}
}

func TestHandleLocationMessage_IgnoredFromDifferentChat(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	mu := &mockTZUpdater{}
	env.b.tzUpdater = mu

	// /tz was invoked in chat 123
	env.b.awaitingLocationChatID = 123
	env.b.awaitingLocationExpiry = time.Now().Add(time.Hour)

	// Location arrives from a different chat (456)
	msg := &tgbotapi.Message{
		Chat: &tgbotapi.Chat{ID: 456},
		Location: &tgbotapi.Location{
			Latitude:  52.52,
			Longitude: 13.40,
		},
		From: &tgbotapi.User{ID: 123456},
	}

	env.b.handleMessage(msg)

	if calls := mu.recordedCalls(); len(calls) != 0 {
		t.Errorf("Expected no UpdateTimezone calls for location from different chat, got %d", len(calls))
	}
	select {
	case body := <-env.messageChan:
		t.Errorf("Expected no message for location from different chat, got: %q", body)
	default:
		// correct — no message sent
	}
}
