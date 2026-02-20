package bot

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func TestIntakeCommand(t *testing.T) {
	s, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed store: %v", err)
	}

	// Mock Server
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true, "result": {"message_id": 123, "chat": {"id": 123}}}`))
	}))
	defer server.Close()

	api, _ := tgbotapi.NewBotAPIWithClient("123:TOKEN", tgbotapi.APIEndpoint, &http.Client{})
	if api == nil {
		api = &tgbotapi.BotAPI{Token: "123:TOKEN", Client: &http.Client{}, Buffer: 100}
	}
	api.SetAPIEndpoint(server.URL + "/bot%s/%s")

	b := &Bot{
		api:           api,
		store:         s,
		allowedUserID: 123456,
	}

	// Enable Food Intake feature
	s.SetFoodIntakeEnabled(context.Background(), true)

	// Test command: /intake 20 10 5 150 Apple
	// Carbs=20, Prot=10, Fat=5, Weight=150, Name=Apple
	// Cals = 20*4 + 10*4 + 5*9 = 80 + 40 + 45 = 165

	msg := &tgbotapi.Message{
		Chat: &tgbotapi.Chat{ID: 123456},
		From: &tgbotapi.User{ID: 123456},
		Date: int(time.Now().Unix()),
		Text: "/intake 20 10 5 150 Apple",
		Entities: []tgbotapi.MessageEntity{
			{Type: "bot_command", Offset: 0, Length: 7},
		},
	}

	b.handleMessage(msg)

	// Verify log created
	logs, err := s.GetFoodLogs(context.Background(), 123456, time.Now(), 1)
	if err != nil {
		t.Fatalf("GetFoodLogs error: %v", err)
	}

	if len(logs) != 1 {
		t.Fatalf("Expected 1 log, got %d", len(logs))
	}

	log := logs[0]
	if log.Name != "Apple" {
		t.Errorf("Expected name Apple, got %s", log.Name)
	}
	if log.Weight != 150 {
		t.Errorf("Expected weight 150, got %d", log.Weight)
	}
	if log.Calories != 243 {
		t.Errorf("Expected calories 243, got %d", log.Calories)
	}
}

func TestIntakeCommand_Disabled(t *testing.T) {
	s, _ := store.New(":memory:")

	// Mock Server
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true, "result": {}}`))
	}))
	defer server.Close()

	api, _ := tgbotapi.NewBotAPIWithClient("123:TOKEN", tgbotapi.APIEndpoint, &http.Client{})
	if api == nil {
		api = &tgbotapi.BotAPI{Token: "123:TOKEN", Client: &http.Client{}, Buffer: 100}
	}
	api.SetAPIEndpoint(server.URL + "/bot%s/%s")

	b := &Bot{api: api, store: s, allowedUserID: 123456}

	// Ensure disabled
	s.SetFoodIntakeEnabled(context.Background(), false)

	msg := &tgbotapi.Message{
		Chat: &tgbotapi.Chat{ID: 123456},
		From: &tgbotapi.User{ID: 123456},
		Text: "/intake 20 10 5 150 Apple",
	}

	b.handleMessage(msg)

	// Verify NO log created
	logs, _ := s.GetFoodLogs(context.Background(), 123456, time.Now(), 1)
	if len(logs) != 0 {
		t.Errorf("Expected 0 logs (feature disabled), got %d", len(logs))
	}
}
