package bot

import (
	"errors"
	"strings"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

type mockTimezoneStore struct {
	recorded   []string
	recordErr  error
	currentTZ  string
	currentErr error
}

func (m *mockTimezoneStore) RecordTimezone(tz string) error {
	if m.recordErr != nil {
		return m.recordErr
	}
	m.recorded = append(m.recorded, tz)
	return nil
}

func (m *mockTimezoneStore) GetCurrentTimezone() (string, error) {
	return m.currentTZ, m.currentErr
}

func TestBotWiring_TZUpdaterIsReachable(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	if env.b.tzUpdater == nil {
		t.Fatal("expected bot.tzUpdater to be wired, got nil")
	}

	mock, ok := env.b.tzUpdater.(*mockTZUpdater)
	if !ok {
		t.Fatalf("expected bot.tzUpdater to be *mockTZUpdater (the test default), got %T", env.b.tzUpdater)
	}

	// Drive the mock through the interface to prove the wiring is end-to-end:
	// future handler code can call b.tzUpdater.UpdateTimezone and the mock
	// will record the call.
	if _, err := env.b.tzUpdater.UpdateTimezone(nil, "Europe/Berlin"); err != nil {
		t.Fatalf("UpdateTimezone via wired mock: %v", err)
	}
	if calls := mock.recordedCalls(); len(calls) != 1 || calls[0] != "Europe/Berlin" {
		t.Errorf("mock should have recorded one call to Europe/Berlin, got %v", calls)
	}
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

	ms := &mockTimezoneStore{}
	env.b.timezone = ms

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

	if len(ms.recorded) != 1 {
		t.Fatalf("Expected 1 timezone recorded, got %d", len(ms.recorded))
	}
	if ms.recorded[0] != "Europe/Berlin" {
		t.Errorf("Expected Europe/Berlin, got %q", ms.recorded[0])
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

	ms := &mockTimezoneStore{recordErr: errors.New("db error")}
	env.b.timezone = ms

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

	if len(ms.recorded) != 0 {
		t.Errorf("Expected 0 recorded timezones on error, got %d", len(ms.recorded))
	}
}

func TestHandleLocationMessage_IgnoredWithoutTZCommand(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	ms := &mockTimezoneStore{}
	env.b.timezone = ms

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

	if len(ms.recorded) != 0 {
		t.Errorf("Expected no timezone recorded for unsolicited location, got %d", len(ms.recorded))
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

	ms := &mockTimezoneStore{}
	env.b.timezone = ms

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
		if len(ms.recorded) == 0 {
			// No timezone found - should be an error/retry message
			if !strings.Contains(body, "not") && !strings.Contains(body, "error") && !strings.Contains(body, "Error") && !strings.Contains(body, "Could not") {
				t.Errorf("Expected error message for no-timezone case, got: %q", body)
			}
		} else {
			// Timezone was found - confirmation should contain the tz name
			if !strings.Contains(body, ms.recorded[0]) {
				t.Errorf("Expected confirmation with tz %q, got: %q", ms.recorded[0], body)
			}
		}
	default:
		t.Fatal("Expected a message to be sent")
	}
}

func TestHandleLocationMessage_IgnoredFromDifferentChat(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	ms := &mockTimezoneStore{}
	env.b.timezone = ms

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

	if len(ms.recorded) != 0 {
		t.Errorf("Expected no timezone recorded for location from different chat, got %d", len(ms.recorded))
	}
	select {
	case body := <-env.messageChan:
		t.Errorf("Expected no message for location from different chat, got: %q", body)
	default:
		// correct — no message sent
	}
}
