package bot

import (
	"errors"
	"strings"
	"testing"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

type mockTimezoneStore struct {
	TimezoneStore
	recorded  []string
	current   string
	recordErr error
}

func (m *mockTimezoneStore) GetCurrentTimezone() (string, error) {
	return m.current, nil
}

func (m *mockTimezoneStore) RecordTimezone(tz string) error {
	if m.recordErr != nil {
		return m.recordErr
	}
	m.recorded = append(m.recorded, tz)
	return nil
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

func TestHandleLocationMessage_InvalidCoords(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	ms := &mockTimezoneStore{}
	env.b.timezone = ms

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
	case <-env.messageChan:
		// message was sent, that's the expected behaviour
	default:
		t.Fatal("Expected a message to be sent")
	}
}
