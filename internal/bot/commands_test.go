package bot

import (
	"context"
	"strings"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

func TestHandleBPCommand(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	msg := &tgbotapi.Message{
		Chat: &tgbotapi.Chat{ID: 123},
		Text: "/bp 120 80 70",
		From: &tgbotapi.User{ID: 123456},
		Entities: []tgbotapi.MessageEntity{
			{Type: "bot_command", Offset: 0, Length: 3},
		},
	}

	env.b.handleMessage(msg)

	select {
	case body := <-env.messageChan:
		if !strings.Contains(body, "120/80") || !strings.Contains(body, "pulse 70") {
			t.Errorf("Unexpected BP response: %s", body)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for BP response")
	}

	// Verify it's in the store
	readings, _ := env.s.GetBloodPressureReadings(context.Background(), 123456, time.Now().Add(-time.Hour))
	if len(readings) != 1 {
		t.Errorf("Expected 1 BP reading, got %d", len(readings))
	}
}

func TestHandleWeightCommand(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	msg := &tgbotapi.Message{
		Chat: &tgbotapi.Chat{ID: 123},
		Text: "/weight 75.5",
		From: &tgbotapi.User{ID: 123456},
		Entities: []tgbotapi.MessageEntity{
			{Type: "bot_command", Offset: 0, Length: 7},
		},
	}

	env.b.handleMessage(msg)

	select {
	case body := <-env.messageChan:
		if !strings.Contains(body, "75.5") {
			t.Errorf("Unexpected weight response: %s", body)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for weight response")
	}
}

func TestHandleStockCommand(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	// Add a medication with low stock
	medID, _ := env.s.CreateMedication("Test Med", "10mg", "{\"type\":\"daily\",\"times\":[\"09:00\"]}", nil, nil, "", "")
	count := 5
	env.s.SetInventory(medID, &count)

	msg := &tgbotapi.Message{
		Chat: &tgbotapi.Chat{ID: 123},
		Text: "/stock",
		From: &tgbotapi.User{ID: 123456},
		Entities: []tgbotapi.MessageEntity{
			{Type: "bot_command", Offset: 0, Length: 6},
		},
	}

	env.b.handleMessage(msg)

	select {
	case body := <-env.messageChan:
		if !strings.Contains(body, "Test Med") || !strings.Contains(body, "5") {
			t.Errorf("Unexpected stock response: %s", body)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for stock response")
	}
}
