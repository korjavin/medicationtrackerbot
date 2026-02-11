package bot

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func TestCheckWorkoutCompletion_PostCompletionAddition(t *testing.T) {
	// 1. Setup DB
	s, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create store: %v", err)
	}

	// 2. Setup Mock Telegram Server with Channel for synchronization
	messageChan := make(chan bool, 100) // Buffer to prevent blocking
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "sendMessage") {
			// Check if this is the completion message
			bodyBytes, _ := io.ReadAll(r.Body)
			bodyStr, _ := url.QueryUnescape(string(bodyBytes))
			if strings.Contains(bodyStr, "Workout Complete") {
				messageChan <- true
			}

			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"ok":true, "result": {"message_id": 123, "chat": {"id": 123}}}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true, "result": {}}`))
	}))
	defer server.Close()

	// 3. Init Bot
	api := &tgbotapi.BotAPI{
		Token:  "TEST_TOKEN",
		Client: &http.Client{},
		Buffer: 100,
	}
	api.SetAPIEndpoint(server.URL + "/bot%s/%s")

	b := &Bot{
		api:           api,
		store:         s,
		allowedUserID: 123456,
	}

	// 4. Setup Data with ROTATION
	userID := int64(123456)
	// Create ROTATING group
	group, err := s.CreateWorkoutGroup("Test Group", "", true, userID, "[1]", "09:00", 15)
	if err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}

	variant1, err := s.CreateWorkoutVariant(group.ID, "Variant 1", nil, "")
	if err != nil {
		t.Fatalf("CreateVariant1: %v", err)
	}

	zero := 0
	variant2, err := s.CreateWorkoutVariant(group.ID, "Variant 2", &zero, "")
	if err != nil {
		t.Fatalf("CreateVariant2: %v", err)
	}

	// Init rotation to Variant 1
	err = s.InitializeRotation(group.ID, variant1.ID)
	if err != nil {
		t.Fatalf("InitializeRotation: %v", err)
	}

	// Add exercise to Variant 1
	ex1, err := s.AddExerciseToVariant(variant1.ID, "Pushups", 3, 10, nil, nil, 0)
	if err != nil {
		t.Fatalf("AddExercise1: %v", err)
	}

	// Create exercise for Variant 2 (so we have a "new" exercise to add later)
	ex2, err := s.AddExerciseToVariant(variant2.ID, "Pullups", 3, 5, nil, nil, 0)
	if err != nil {
		t.Fatalf("AddExercise2: %v", err)
	}

	// Create session for Variant 1
	session, err := s.CreateWorkoutSession(group.ID, variant1.ID, userID, time.Now(), "09:00")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	// 5. Complete session normally via CALLBACK CHAIN
	err = s.StartSession(session.ID)
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	// Check initial rotation state
	rotState, err := s.GetRotationState(group.ID)
	if err != nil {
		t.Fatalf("GetRotationState: %v", err)
	}
	if rotState.CurrentVariantID != variant1.ID {
		t.Fatalf("Expected initial variant %d, got %d", variant1.ID, rotState.CurrentVariantID)
	}

	// Simulate "Done" callback for first exercise
	// Create callback query
	cb := &tgbotapi.CallbackQuery{
		From: &tgbotapi.User{ID: 123456},
		Message: &tgbotapi.Message{
			Chat:      &tgbotapi.Chat{ID: 123},
			MessageID: 111,
			Text:      "Pushups",
		},
		Data: fmt.Sprintf("exercise_done_%d_%d", session.ID, ex1.ID),
	}

	// Consume any previous message tokens
loop:
	for {
		select {
		case <-messageChan:
		default:
			break loop
		}
	}

	// Handle callback - this should log exercise AND trigger completion check
	b.handleExerciseCallback(cb, cb.Data)

	// Wait for completion message
	select {
	case <-messageChan:
		// Success - completion message sent
	case <-time.After(1 * time.Second):
		t.Fatalf("Timeout waiting for initial completion message")
	}

	// Verify session is completed
	session, err = s.GetWorkoutSession(session.ID)
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if session.Status != "completed" {
		t.Fatalf("Expected session status 'completed', got '%s'", session.Status)
	}

	// Verify rotation advanced to Variant 2
	rotState, err = s.GetRotationState(group.ID)
	if err != nil {
		t.Fatalf("GetRotationState: %v", err)
	}
	if rotState.CurrentVariantID != variant2.ID {
		t.Fatalf("Expected rotation to advance to Variant 2 (%d), got %d", variant2.ID, rotState.CurrentVariantID)
	}

	// 6. User adds a NEW exercise (ex2 from Variant 2) *after* completion
	// Simulate "Done" callback for the NEW exercise
	cb2 := &tgbotapi.CallbackQuery{
		From: &tgbotapi.User{ID: 123456},
		Message: &tgbotapi.Message{
			Chat:      &tgbotapi.Chat{ID: 123},
			MessageID: 222,
			Text:      "Pullups",
		},
		Data: fmt.Sprintf("exercise_done_%d_%d", session.ID, ex2.ID),
	}

	// Consume any previous message tokens
loop2:
	for {
		select {
		case <-messageChan:
		default:
			break loop2
		}
	}

	// 7. Call handler
	b.handleExerciseCallback(cb2, cb2.Data)

	// 8. Assertions

	// P2: Verify completion message sent again via channel
	select {
	case <-messageChan:
		// Success
	case <-time.After(1 * time.Second):
		t.Fatalf("timeout: Expected completion message to be sent again after adding extra exercise")
	}

	// P3: Verify rotation did NOT advance again (should still be Variant 2)
	rotState, err = s.GetRotationState(group.ID)
	if err != nil {
		t.Fatalf("GetRotationState: %v", err)
	}

	// If it advanced again, it would wrap back to Variant 1 (because only 2 variants)
	if rotState.CurrentVariantID != variant2.ID {
		t.Fatalf("Rotation advanced unexpectedly! Expected %d, got %d", variant2.ID, rotState.CurrentVariantID)
	}
}

func TestPrematureCompletion_DuplicateLogs(t *testing.T) {
	// P2 Check: Verify that duplicate logs for same exercise don't trigger completion
	s, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed store: %v", err)
	}

	messageChan := make(chan bool, 100)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "sendMessage") {
			bodyBytes, _ := io.ReadAll(r.Body)
			bodyStr, _ := url.QueryUnescape(string(bodyBytes))
			if strings.Contains(bodyStr, "Workout Complete") {
				messageChan <- true
			}
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"ok":true, "result": {"message_id": 123, "chat": {"id": 123}}}`))
		}
	}))
	defer server.Close()

	api := &tgbotapi.BotAPI{Token: "TEST", Client: &http.Client{}}
	api.SetAPIEndpoint(server.URL + "/bot%s/%s")
	b := &Bot{api: api, store: s, allowedUserID: 1}

	// Create group/variant with 2 exercises
	group, _ := s.CreateWorkoutGroup("G", "", false, 1, "[1]", "09:00", 15)
	variant, _ := s.CreateWorkoutVariant(group.ID, "V", nil, "")
	ex1, _ := s.AddExerciseToVariant(variant.ID, "Ex1", 3, 10, nil, nil, 0)
	ex2, _ := s.AddExerciseToVariant(variant.ID, "Ex2", 3, 10, nil, nil, 1)

	session, _ := s.CreateWorkoutSession(group.ID, variant.ID, 1, time.Now(), "09:00")
	s.StartSession(session.ID)

	// Log Ex1 TWICE (simulate double click)
	cb := &tgbotapi.CallbackQuery{
		From:    &tgbotapi.User{ID: 1},
		Message: &tgbotapi.Message{Chat: &tgbotapi.Chat{ID: 1}, MessageID: 1},
		Data:    fmt.Sprintf("exercise_done_%d_%d", session.ID, ex1.ID),
	}

	b.handleExerciseCallback(cb, cb.Data)
	b.handleExerciseCallback(cb, cb.Data)

	// Should NOT complete because Ex2 is not done
	select {
	case <-messageChan:
		t.Fatalf("Premature completion! Session completed despite Exam 2 remaining")
	case <-time.After(100 * time.Millisecond):
		// OK
	}

	// Verify status
	session, _ = s.GetWorkoutSession(session.ID)
	if session.Status == "completed" {
		t.Error("Session marked completed prematurely")
	}

	// Now complete Ex2
	cb2 := &tgbotapi.CallbackQuery{
		From:    &tgbotapi.User{ID: 1},
		Message: &tgbotapi.Message{Chat: &tgbotapi.Chat{ID: 1}, MessageID: 2},
		Data:    fmt.Sprintf("exercise_done_%d_%d", session.ID, ex2.ID),
	}
	b.handleExerciseCallback(cb2, cb2.Data)

	// Should complete now
	select {
	case <-messageChan:
		// OK
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for completion message")
	}

	session, _ = s.GetWorkoutSession(session.ID)
	if session.Status != "completed" {
		t.Error("Session not marked completed after all exercises done")
	}
}
