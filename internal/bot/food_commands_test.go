package bot

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/korjavin/medicationtrackerbot/internal/domain"
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
		meds:          s,
		bp:            s,
		weight:        s,
		workouts:      s,
		food:          s,
		imports:       s,
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

	b := &Bot{api: api, meds: s, bp: s, weight: s, workouts: s, food: s, imports: s, allowedUserID: 123456}

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

type mockFoodStore struct {
	FoodStore // Embed interface to fulfill requirements without implementing everything

	enabled bool
	err     error

	logs []*store.FoodLog
}

func (m *mockFoodStore) GetFoodIntakeEnabled(ctx context.Context) (bool, error) {
	return m.enabled, m.err
}

func (m *mockFoodStore) CreateFoodLog(ctx context.Context, f *store.FoodLog) (int64, error) {
	if m.err != nil {
		return 0, m.err
	}
	m.logs = append(m.logs, f)
	return 1, nil
}

type mockFoodAI struct {
	logs []domain.FoodLog
	err  error
}

func (m *mockFoodAI) ParseMealDescription(ctx context.Context, description string) ([]domain.FoodLog, error) {
	if m.err != nil {
		return nil, m.err
	}
	return m.logs, nil
}

func TestHandleFoodCommand_Disabled(t *testing.T) {
	bot := &Bot{
		food: &mockFoodStore{enabled: false},
	}
	msg := &tgbotapi.Message{}
	msgConfig := &tgbotapi.MessageConfig{}

	bot.handleFoodCommand(msg, msgConfig)

	if !strings.Contains(msgConfig.Text, "disabled in settings") {
		t.Errorf("Expected disabled message, got %s", msgConfig.Text)
	}
}

func TestHandleFoodCommand_NoAI(t *testing.T) {
	bot := &Bot{
		food:   &mockFoodStore{enabled: true},
		foodAI: nil,
	}
	msg := &tgbotapi.Message{}
	msgConfig := &tgbotapi.MessageConfig{}

	bot.handleFoodCommand(msg, msgConfig)

	if !strings.Contains(msgConfig.Text, "not configured") {
		t.Errorf("Expected missing API key message, got %s", msgConfig.Text)
	}
}

func TestHandleFoodCommand_NoArgs(t *testing.T) {
	bot := &Bot{
		food:   &mockFoodStore{enabled: true},
		foodAI: &mockFoodAI{},
	}
	msg := &tgbotapi.Message{
		Text: "/food",
		Entities: []tgbotapi.MessageEntity{
			{Type: "bot_command", Offset: 0, Length: 5},
		},
	}
	msgConfig := &tgbotapi.MessageConfig{}

	bot.handleFoodCommand(msg, msgConfig)

	if !strings.Contains(msgConfig.Text, "Usage: /food <description>") {
		t.Errorf("Expected usage text, got %s", msgConfig.Text)
	}
}

func TestHandleFoodCommand_AIError(t *testing.T) {
	store := &mockFoodStore{enabled: true}
	ai := &mockFoodAI{err: errors.New("simulated AI failure")}
	b := newFoodHandlerBot(t, store, ai)

	msg := newFoodMsg(123456)
	msgConfig := &tgbotapi.MessageConfig{}

	b.handleFoodCommand(msg, msgConfig)

	if !strings.HasPrefix(msgConfig.Text, "❌ Failed to analyze meal:") {
		t.Errorf("expected AI error prefix, got: %s", msgConfig.Text)
	}
	if !strings.Contains(msgConfig.Text, "simulated AI failure") {
		t.Errorf("expected underlying error in reply, got: %s", msgConfig.Text)
	}
	if len(store.logs) != 0 {
		t.Errorf("expected no persisted logs on AI error, got %d", len(store.logs))
	}
}

func TestHandleFoodCommand_AllPersistenceFails(t *testing.T) {
	store := &errFoodStore{
		mockFoodStore: mockFoodStore{enabled: true},
		failNames:     map[string]bool{"Rice": true, "Chicken Breast": true},
	}
	ai := &mockFoodAI{logs: []domain.FoodLog{
		{Name: "Rice", Weight: 150, Carbs: 40, Protein: 4, Fat: 1, Calories: 185},
		{Name: "Chicken Breast", Weight: 200, Carbs: 0, Protein: 62, Fat: 7, Calories: 311},
	}}
	b := newFoodHandlerBot(t, store, ai)

	msg := newFoodMsg(123456)
	msgConfig := &tgbotapi.MessageConfig{}

	b.handleFoodCommand(msg, msgConfig)

	if !strings.Contains(msgConfig.Text, "Error saving food log to database") {
		t.Errorf("expected all-failed error text, got: %s", msgConfig.Text)
	}
	if len(store.logs) != 0 {
		t.Errorf("expected no persisted logs when every save fails, got %d", len(store.logs))
	}
}

func TestHandleFoodCommand_SettingsError(t *testing.T) {
	store := &mockFoodStore{err: errors.New("db unreachable")}
	ai := &mockFoodAI{}
	b := newFoodHandlerBot(t, store, ai)

	msg := newFoodMsg(123456)
	msgConfig := &tgbotapi.MessageConfig{}

	b.handleFoodCommand(msg, msgConfig)

	if !strings.Contains(msgConfig.Text, "Error checking settings") {
		t.Errorf("expected settings error message, got: %s", msgConfig.Text)
	}
}

// errFoodStore allows simulating a persistence failure for specific item names.
type errFoodStore struct {
	mockFoodStore
	failNames map[string]bool
}

func (m *errFoodStore) CreateFoodLog(ctx context.Context, f *store.FoodLog) (int64, error) {
	if m.failNames[f.Name] {
		return 0, fmt.Errorf("simulated persistence failure")
	}
	m.logs = append(m.logs, f)
	return 1, nil
}

func newFoodHandlerBot(t *testing.T, food FoodStore, ai domain.FoodAIService) *Bot {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true, "result": {"message_id": 999, "chat": {"id": 123}}}`))
	}))
	t.Cleanup(server.Close)

	api, _ := tgbotapi.NewBotAPIWithClient("123:TOKEN", tgbotapi.APIEndpoint, &http.Client{})
	if api == nil {
		api = &tgbotapi.BotAPI{Token: "123:TOKEN", Client: &http.Client{}, Buffer: 100}
	}
	api.SetAPIEndpoint(server.URL + "/bot%s/%s")

	return &Bot{
		api:           api,
		food:          food,
		foodAI:        ai,
		allowedUserID: 123456,
	}
}

func newFoodMsg(chatID int64) *tgbotapi.Message {
	return &tgbotapi.Message{
		Chat: &tgbotapi.Chat{ID: chatID},
		From: &tgbotapi.User{ID: chatID},
		Date: int(time.Now().Unix()),
		Text: "/food anything goes here",
		Entities: []tgbotapi.MessageEntity{
			{Type: "bot_command", Offset: 0, Length: 5},
		},
	}
}

func TestHandleFoodCommand_SingleItem(t *testing.T) {
	store := &mockFoodStore{enabled: true}
	ai := &mockFoodAI{logs: []domain.FoodLog{
		{Name: "Chicken Breast", Weight: 200, Carbs: 0, Protein: 62, Fat: 7, Calories: 310},
	}}
	b := newFoodHandlerBot(t, store, ai)

	msg := newFoodMsg(123456)
	msgConfig := &tgbotapi.MessageConfig{}

	b.handleFoodCommand(msg, msgConfig)

	if !strings.Contains(msgConfig.Text, "Logged 1 item") {
		t.Errorf("expected single-item header, got: %s", msgConfig.Text)
	}
	if !strings.Contains(msgConfig.Text, "Chicken Breast") {
		t.Errorf("expected item name in reply, got: %s", msgConfig.Text)
	}
	if !strings.Contains(msgConfig.Text, "310 kcal") {
		t.Errorf("expected total calories in reply, got: %s", msgConfig.Text)
	}
	if len(store.logs) != 1 {
		t.Fatalf("expected 1 persisted log, got %d", len(store.logs))
	}
	if store.logs[0].UserID != 123456 {
		t.Errorf("expected UserID=123456, got %d", store.logs[0].UserID)
	}
}

func TestHandleFoodCommand_MultiItem(t *testing.T) {
	store := &mockFoodStore{enabled: true}
	ai := &mockFoodAI{logs: []domain.FoodLog{
		{Name: "Rice", Weight: 150, Carbs: 40, Protein: 4, Fat: 1, Calories: 185},
		{Name: "Chicken Breast", Weight: 200, Carbs: 0, Protein: 62, Fat: 7, Calories: 311},
		{Name: "Broccoli", Weight: 100, Carbs: 7, Protein: 3, Fat: 0, Calories: 40},
	}}
	b := newFoodHandlerBot(t, store, ai)

	msg := newFoodMsg(123456)
	msgConfig := &tgbotapi.MessageConfig{}

	b.handleFoodCommand(msg, msgConfig)

	if !strings.Contains(msgConfig.Text, "Logged 3 items") {
		t.Errorf("expected 'Logged 3 items' header, got: %s", msgConfig.Text)
	}
	for _, name := range []string{"Rice", "Chicken Breast", "Broccoli"} {
		if !strings.Contains(msgConfig.Text, name) {
			t.Errorf("expected item %q in reply, got: %s", name, msgConfig.Text)
		}
	}

	// totals: carbs 47, protein 69, fat 8, cals 536, weight 450
	if !strings.Contains(msgConfig.Text, "📊 Total: 47g C / 69g P / 8g F") {
		t.Errorf("expected aggregate Total line, got: %s", msgConfig.Text)
	}
	if !strings.Contains(msgConfig.Text, "536 kcal") {
		t.Errorf("expected aggregate calories, got: %s", msgConfig.Text)
	}
	if !strings.Contains(msgConfig.Text, "450g") {
		t.Errorf("expected aggregate weight, got: %s", msgConfig.Text)
	}

	if len(store.logs) != 3 {
		t.Fatalf("expected 3 persisted logs, got %d", len(store.logs))
	}
	// All items share the same eaten_at timestamp
	first := store.logs[0].EatenAt
	for i, log := range store.logs {
		if !log.EatenAt.Equal(first) {
			t.Errorf("log %d has different EatenAt (%v vs %v)", i, log.EatenAt, first)
		}
	}
}

func TestHandleFoodCommand_PartialFailure(t *testing.T) {
	store := &errFoodStore{
		mockFoodStore: mockFoodStore{enabled: true},
		failNames:     map[string]bool{"Broccoli": true},
	}
	ai := &mockFoodAI{logs: []domain.FoodLog{
		{Name: "Rice", Weight: 150, Carbs: 40, Protein: 4, Fat: 1, Calories: 185},
		{Name: "Broccoli", Weight: 100, Carbs: 7, Protein: 3, Fat: 0, Calories: 40},
		{Name: "Chicken Breast", Weight: 200, Carbs: 0, Protein: 62, Fat: 7, Calories: 311},
	}}
	b := newFoodHandlerBot(t, store, ai)

	msg := newFoodMsg(123456)
	msgConfig := &tgbotapi.MessageConfig{}

	b.handleFoodCommand(msg, msgConfig)

	if !strings.Contains(msgConfig.Text, "Logged 2 of 3 items") {
		t.Errorf("expected partial-success header, got: %s", msgConfig.Text)
	}
	if !strings.Contains(msgConfig.Text, "1 failed") {
		t.Errorf("expected failure count in header, got: %s", msgConfig.Text)
	}
	if strings.Contains(msgConfig.Text, "Broccoli") {
		t.Errorf("failed item Broccoli should not appear in summary, got: %s", msgConfig.Text)
	}
	if len(store.logs) != 2 {
		t.Fatalf("expected 2 successful persistence calls, got %d", len(store.logs))
	}
}

func TestHandleFoodCommand_ZeroItems(t *testing.T) {
	store := &mockFoodStore{enabled: true}
	ai := &mockFoodAI{logs: []domain.FoodLog{}}
	b := newFoodHandlerBot(t, store, ai)

	msg := newFoodMsg(123456)
	msgConfig := &tgbotapi.MessageConfig{}

	b.handleFoodCommand(msg, msgConfig)

	if !strings.Contains(msgConfig.Text, "no meal items") {
		t.Errorf("expected empty-items error, got: %s", msgConfig.Text)
	}
	if len(store.logs) != 0 {
		t.Errorf("expected no persisted logs, got %d", len(store.logs))
	}
}
