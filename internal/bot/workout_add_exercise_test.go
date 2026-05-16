package bot

import (
	"fmt"
	"strings"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

func TestSendExerciseList_Pagination(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	userID := int64(123456)
	group, _ := env.s.Workout.CreateGroup("Test Group", "", false, userID, "[1]", "09:00", 15)
	variant, _ := env.s.Workout.CreateVariant(group.ID, "A", nil, "")

	// Add 15 exercises to trigger pagination
	for i := 1; i <= 15; i++ {
		env.s.Workout.CreateExerciseInVariant(variant.ID, fmt.Sprintf("Exercise %d", i), 3, 10, nil, nil, 0)
	}

	session, _ := env.s.Workout.CreateSession(group.ID, variant.ID, userID, time.Now(), "09:00")
	env.s.Workout.StartSession(session.ID)

	// drain any messages that might be sent automatically during setup
	drainMessages(env)

	// Test page 0 (first 10 items)
	_, err := env.b.SendExerciseList(session.ID, userID)
	if err != nil {
		t.Fatalf("SendExerciseList: %v", err)
	}

	select {
	case msg := <-env.messageChan:
		if !strings.Contains(msg, "Page 1/2") {
			t.Errorf("Expected Page 1/2 in response, got: %s", msg)
		}
		if !strings.Contains(msg, "Next ▶️") {
			t.Errorf("Expected Next button in response, got: %s", msg)
		}
		if strings.Contains(msg, "◀️ Previous") {
			t.Errorf("Did not expect Previous button on first page, got: %s", msg)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for exercise list page 0")
	}

	// Test page 1 (next 5 items)
	_, err = env.b.sendExerciseListPage(session.ID, userID, 1)
	if err != nil {
		t.Fatalf("sendExerciseListPage(1): %v", err)
	}

	select {
	case msg := <-env.messageChan:
		if !strings.Contains(msg, "Page 2/2") {
			t.Errorf("Expected Page 2/2 in response, got: %s", msg)
		}
		if !strings.Contains(msg, "◀️ Previous") {
			t.Errorf("Expected Previous button in response, got: %s", msg)
		}
		if strings.Contains(msg, "Next ▶️") {
			t.Errorf("Did not expect Next button on last page, got: %s", msg)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for exercise list page 1")
	}
}

func TestSendExerciseList_SessionNotActive(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	userID := int64(123456)
	group, _ := env.s.Workout.CreateGroup("Test", "", false, userID, "[1]", "09:00", 15)
	variant, _ := env.s.Workout.CreateVariant(group.ID, "A", nil, "")
	env.s.Workout.CreateExerciseInVariant(variant.ID, "Ex 1", 3, 10, nil, nil, 0)

	// create session but don't start it (status=pending)
	session, _ := env.s.Workout.CreateSession(group.ID, variant.ID, userID, time.Now(), "09:00")

	_, err := env.b.SendExerciseList(session.ID, userID)
	if err == nil || !strings.Contains(err.Error(), "session is not active") {
		t.Errorf("Expected 'session is not active' error, got %v", err)
	}
}

func TestHandleExercisePageCallback(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	userID := int64(123456)
	group, _ := env.s.Workout.CreateGroup("Test Group", "", false, userID, "[1]", "09:00", 15)
	variant, _ := env.s.Workout.CreateVariant(group.ID, "A", nil, "")

	for i := 1; i <= 15; i++ {
		env.s.Workout.CreateExerciseInVariant(variant.ID, fmt.Sprintf("Ex %d", i), 3, 10, nil, nil, 0)
	}

	session, _ := env.s.Workout.CreateSession(group.ID, variant.ID, userID, time.Now(), "09:00")
	env.s.Workout.StartSession(session.ID)

	drainMessages(env)

	cb := &tgbotapi.CallbackQuery{
		ID:   "cid",
		From: &tgbotapi.User{ID: userID},
		Message: &tgbotapi.Message{
			MessageID: 200,
			Chat:      &tgbotapi.Chat{ID: userID},
		},
	}
	env.b.handleExercisePageCallback(cb, session.ID, 1)

	// Check if page 2 was sent
	select {
	case msg := <-env.messageChan:
		// Expect page 2 response
		if !strings.Contains(msg, "Page 2/2") {
			t.Errorf("Expected Page 2/2 in response, got: %s", msg)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for paginated exercise list")
	}
}

func TestHandleSelectExerciseCallback_SessionNotActive(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	userID := int64(123456)
	group, _ := env.s.Workout.CreateGroup("Test", "", false, userID, "[1]", "09:00", 15)
	variant, _ := env.s.Workout.CreateVariant(group.ID, "A", nil, "")
	ex, _ := env.s.Workout.CreateExerciseInVariant(variant.ID, "Ex 1", 3, 10, nil, nil, 0)

	session, _ := env.s.Workout.CreateSession(group.ID, variant.ID, userID, time.Now(), "09:00")
	// don't start session (status=pending)

	drainMessages(env)

	cb := &tgbotapi.CallbackQuery{
		ID:   "cid",
		From: &tgbotapi.User{ID: userID},
		Message: &tgbotapi.Message{
			MessageID: 200,
			Chat:      &tgbotapi.Chat{ID: userID},
		},
	}

	env.b.handleSelectExerciseCallback(cb, session.ID, ex.ID)

	select {
	case msg := <-env.messageChan:
		if !strings.Contains(msg, "no longer active") {
			t.Errorf("Expected 'no longer active' message, got: %s", msg)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for message")
	}
}

func TestHandleSelectExerciseCallback_WrongUser(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	userID := int64(123456)
	group, _ := env.s.Workout.CreateGroup("Test", "", false, userID, "[1]", "09:00", 15)
	variant, _ := env.s.Workout.CreateVariant(group.ID, "A", nil, "")
	ex, _ := env.s.Workout.CreateExerciseInVariant(variant.ID, "Ex 1", 3, 10, nil, nil, 0)

	session, _ := env.s.Workout.CreateSession(group.ID, variant.ID, userID, time.Now(), "09:00")
	env.s.Workout.StartSession(session.ID)

	drainMessages(env)

	cb := &tgbotapi.CallbackQuery{
		ID:   "cid",
		From: &tgbotapi.User{ID: 999999}, // wrong user
		Message: &tgbotapi.Message{
			MessageID: 200,
			Chat:      &tgbotapi.Chat{ID: 999999},
		},
	}

	env.b.handleSelectExerciseCallback(cb, session.ID, ex.ID)

	select {
	case msg := <-env.messageChan:
		if !strings.Contains(msg, "Access denied") {
			t.Errorf("Expected 'Access denied' message, got: %s", msg)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for message")
	}
}

func TestHandleSelectExerciseCallback_ExerciseNotFound(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	userID := int64(123456)
	group, _ := env.s.Workout.CreateGroup("Test", "", false, userID, "[1]", "09:00", 15)
	variant, _ := env.s.Workout.CreateVariant(group.ID, "A", nil, "")

	session, _ := env.s.Workout.CreateSession(group.ID, variant.ID, userID, time.Now(), "09:00")
	env.s.Workout.StartSession(session.ID)

	drainMessages(env)

	cb := &tgbotapi.CallbackQuery{
		ID:   "cid",
		From: &tgbotapi.User{ID: userID},
		Message: &tgbotapi.Message{
			MessageID: 200,
			Chat:      &tgbotapi.Chat{ID: userID},
		},
	}

	env.b.handleSelectExerciseCallback(cb, session.ID, 9999)

	select {
	case msg := <-env.messageChan:
		if !strings.Contains(msg, "Exercise not found") {
			t.Errorf("Expected 'Exercise not found' message, got: %s", msg)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for message")
	}
}

func TestHandleSelectExerciseCallback_ExerciseNotAllowed(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	userID1 := int64(123456)
	userID2 := int64(999999)

	// User 1 group and session
	group1, _ := env.s.Workout.CreateGroup("Test 1", "", false, userID1, "[1]", "09:00", 15)
	variant1, _ := env.s.Workout.CreateVariant(group1.ID, "A", nil, "")

	// User 2 group and exercise (in library)
	libItem2, _ := env.s.Workout.CreateExerciseLibraryItem(userID2, "Ex 2", 3, 10, nil, nil, "")

	session1, _ := env.s.Workout.CreateSession(group1.ID, variant1.ID, userID1, time.Now(), "09:00")
	env.s.Workout.StartSession(session1.ID)

	drainMessages(env)

	cb := &tgbotapi.CallbackQuery{
		ID:   "cid",
		From: &tgbotapi.User{ID: userID1},
		Message: &tgbotapi.Message{
			MessageID: 200,
			Chat:      &tgbotapi.Chat{ID: userID1},
		},
	}

	// User 1 trying to add User 2's library exercise
	env.b.handleSelectExerciseCallback(cb, session1.ID, libItem2.ID)

	select {
	case msg := <-env.messageChan:
		if !strings.Contains(msg, "not available") {
			t.Errorf("Expected 'not available' message, got: %s", msg)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for message")
	}
}

// TestHandleSelectExerciseCallback_FromLibrary reproduces the bug where exercises
// added only to the exercise library (not to any workout variant) could not be
// selected during a session — they caused "Exercise not found" because the code
// incorrectly called GetExercise (workout_exercises table) instead of
// GetExerciseLibraryItem (exercise_library table).
func TestHandleSelectExerciseCallback_FromLibrary(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	userID := int64(123456)

	// Create exercise ONLY in the library (not in any variant)
	libItem, err := env.s.Workout.CreateExerciseLibraryItem(userID, "Kettlebell Swings", 3, 15, nil, nil, "")
	if err != nil {
		t.Fatalf("CreateExerciseLibraryItem: %v", err)
	}

	// Create a session
	group, _ := env.s.Workout.CreateGroup("Test", "", false, userID, "[1]", "09:00", 15)
	variant, _ := env.s.Workout.CreateVariant(group.ID, "A", nil, "")
	session, _ := env.s.Workout.CreateSession(group.ID, variant.ID, userID, time.Now(), "09:00")
	env.s.Workout.StartSession(session.ID)

	drainMessages(env)

	cb := &tgbotapi.CallbackQuery{
		ID:   "cid",
		From: &tgbotapi.User{ID: userID},
		Message: &tgbotapi.Message{
			MessageID: 200,
			Chat:      &tgbotapi.Chat{ID: userID},
		},
	}

	// The callback data contains the library item ID (as returned by ListAllUniqueExercises)
	env.b.handleSelectExerciseCallback(cb, session.ID, libItem.ID)

	select {
	case msg := <-env.messageChan:
		if strings.Contains(msg, "Exercise not found") {
			t.Errorf("Bug reproduced: got 'Exercise not found' — library ID %d was looked up in wrong table", libItem.ID)
		}
		if strings.Contains(msg, "not available") {
			t.Errorf("Exercise found but blocked by validation — check allowed list logic")
		}
		// Expect exercise prompt with the exercise name
		if !strings.Contains(msg, "Kettlebell") {
			t.Errorf("Expected exercise prompt with name 'Kettlebell', got: %s", msg)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for exercise prompt")
	}
}

// TestSendExerciseList_HasCancelButton verifies that a Cancel button appears
// in the exercise selection list so the user can back out without being forced
// to select an exercise.
func TestSendExerciseList_HasCancelButton(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	userID := int64(123456)
	env.s.Workout.CreateExerciseLibraryItem(userID, "Push-ups", 3, 10, nil, nil, "")

	group, _ := env.s.Workout.CreateGroup("Test", "", false, userID, "[1]", "09:00", 15)
	variant, _ := env.s.Workout.CreateVariant(group.ID, "A", nil, "")
	session, _ := env.s.Workout.CreateSession(group.ID, variant.ID, userID, time.Now(), "09:00")
	env.s.Workout.StartSession(session.ID)

	drainMessages(env)

	_, err := env.b.SendExerciseList(session.ID, userID)
	if err != nil {
		t.Fatalf("SendExerciseList: %v", err)
	}

	select {
	case msg := <-env.messageChan:
		if !strings.Contains(msg, "cancel_add_exercise") {
			t.Errorf("Expected cancel_add_exercise callback in keyboard, got: %s", msg)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for exercise list")
	}
}
