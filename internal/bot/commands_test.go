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
		Date: 1771232400, // 2026-02-17 09:00:00 UTC
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
	readings, err := env.s.GetBloodPressureReadings(context.Background(), 123456, time.Time{})
	if err != nil {
		t.Fatalf("Error getting BP readings: %v", err)
	}
	if len(readings) != 1 {
		t.Errorf("Expected 1 BP reading, got %d", len(readings))
	} else {
		expectedTime := time.Unix(1771232400, 0)
		if !readings[0].MeasuredAt.Equal(expectedTime) {
			t.Errorf("Expected MeasuredAt %v, got %v", expectedTime, readings[0].MeasuredAt)
		}
	}
}

func TestHandleWeightCommand(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	msg := &tgbotapi.Message{
		Chat: &tgbotapi.Chat{ID: 123},
		Text: "/weight 75.5",
		From: &tgbotapi.User{ID: 123456},
		Date: 1771232460, // 2026-02-17 09:01:00 UTC
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
	// Verify it's in the store
	logs, err := env.s.GetWeightLogs(context.Background(), 123456, time.Time{})
	if err != nil {
		t.Fatalf("Error getting weight logs: %v", err)
	}
	if len(logs) != 1 {
		t.Errorf("Expected 1 weight log, got %d", len(logs))
	} else {
		expectedTime := time.Unix(1771232460, 0)
		if !logs[0].MeasuredAt.Equal(expectedTime) {
			t.Errorf("Expected MeasuredAt %v, got %v", expectedTime, logs[0].MeasuredAt)
		}
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
