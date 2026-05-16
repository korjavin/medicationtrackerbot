package bot

import (
	"fmt"
	"strings"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

func TestStartExerciseLoop_5Exercises_Sends3_Stores2Pending(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	userID := int64(123456)

	g, err := env.s.Workout.CreateGroup("G", "desc", false, userID, "[0]", "09:00", 15)
	if err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}
	order := 0
	v, err := env.s.Workout.CreateVariant(g.ID, "V", &order, "")
	if err != nil {
		t.Fatalf("CreateVariant: %v", err)
	}

	for i := 1; i <= 5; i++ {
		_, err := env.s.Workout.CreateExerciseInVariant(v.ID, fmt.Sprintf("Exercise %d", i), 3, 10, nil, nil, i)
		if err != nil {
			t.Fatalf("CreateExerciseInVariant %d: %v", i, err)
		}
	}

	session, err := env.s.Workout.CreateSession(g.ID, v.ID, userID, time.Now(), "09:00")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	env.b.startExerciseLoop(session.ID, v.ID, userID)

	time.Sleep(50 * time.Millisecond)

	// Count sendMessage calls (start message + 3 exercise prompts = 4)
	sendCount := 0
	var startMsgBody string
drainLoop:
	for {
		select {
		case msg := <-env.messageChan:
			sendCount++
			if strings.Contains(msg, "Workout Started") {
				startMsgBody = msg
			}
		case <-time.After(10 * time.Millisecond):
			break drainLoop
		}
	}

	// 1 start message + 3 exercise prompts
	if sendCount != 4 {
		t.Errorf("Expected 4 sent messages (1 start + 3 exercises), got %d", sendCount)
	}

	// Start message should mention batching
	if !strings.Contains(startMsgBody, "showing first 3") {
		t.Errorf("Expected start message to mention 'showing first 3', got: %s", startMsgBody)
	}

	// Check pending exercises
	env.b.pendingExercisesMu.Lock()
	pending := env.b.pendingExercises[session.ID]
	pendingCount := len(pending)
	env.b.pendingExercisesMu.Unlock()

	if pendingCount != 2 {
		t.Errorf("Expected 2 pending exercises, got %d", pendingCount)
	}
}

func TestStartExerciseLoop_2Exercises_SendsAll_NoPending(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	userID := int64(123456)

	g, err := env.s.Workout.CreateGroup("G", "desc", false, userID, "[0]", "09:00", 15)
	if err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}
	order := 0
	v, err := env.s.Workout.CreateVariant(g.ID, "V", &order, "")
	if err != nil {
		t.Fatalf("CreateVariant: %v", err)
	}

	for i := 1; i <= 2; i++ {
		_, err := env.s.Workout.CreateExerciseInVariant(v.ID, fmt.Sprintf("Exercise %d", i), 3, 10, nil, nil, i)
		if err != nil {
			t.Fatalf("CreateExerciseInVariant %d: %v", i, err)
		}
	}

	session, err := env.s.Workout.CreateSession(g.ID, v.ID, userID, time.Now(), "09:00")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	env.b.startExerciseLoop(session.ID, v.ID, userID)

	time.Sleep(50 * time.Millisecond)

	// Count sendMessage calls (start message + 2 exercise prompts = 3)
	sendCount := 0
	var startMsgBody string
drainLoop:
	for {
		select {
		case msg := <-env.messageChan:
			sendCount++
			if strings.Contains(msg, "Workout Started") {
				startMsgBody = msg
			}
		case <-time.After(10 * time.Millisecond):
			break drainLoop
		}
	}

	// 1 start message + 2 exercise prompts
	if sendCount != 3 {
		t.Errorf("Expected 3 sent messages (1 start + 2 exercises), got %d", sendCount)
	}

	// Start message should NOT mention batching
	if strings.Contains(startMsgBody, "showing first") {
		t.Errorf("Expected start message NOT to mention batching for <= 3 exercises, got: %s", startMsgBody)
	}

	// Check no pending exercises
	env.b.pendingExercisesMu.Lock()
	pending := env.b.pendingExercises[session.ID]
	pendingCount := len(pending)
	env.b.pendingExercisesMu.Unlock()

	if pendingCount != 0 {
		t.Errorf("Expected 0 pending exercises, got %d", pendingCount)
	}
}

func TestExerciseCallback_DoneSendsNextPending(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	userID := int64(123456)

	g, err := env.s.Workout.CreateGroup("G", "desc", false, userID, "[0]", "09:00", 15)
	if err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}
	order := 0
	v, err := env.s.Workout.CreateVariant(g.ID, "V", &order, "")
	if err != nil {
		t.Fatalf("CreateVariant: %v", err)
	}

	for i := 1; i <= 5; i++ {
		_, err := env.s.Workout.CreateExerciseInVariant(v.ID, fmt.Sprintf("Exercise %d", i), 3, 10, nil, nil, i)
		if err != nil {
			t.Fatalf("CreateExerciseInVariant %d: %v", i, err)
		}
	}

	session, err := env.s.Workout.CreateSession(g.ID, v.ID, userID, time.Now(), "09:00")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if err := env.b.workoutSvc.StartSession(session.ID); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	// Start exercise loop (sends 3, queues 2)
	env.b.startExerciseLoop(session.ID, v.ID, userID)
	time.Sleep(50 * time.Millisecond)

	// Drain all messages from the start
drainStart:
	for {
		select {
		case <-env.messageChan:
		case <-env.requestChan:
		case <-time.After(10 * time.Millisecond):
			break drainStart
		}
	}

	// Verify 2 pending before callback
	env.b.pendingExercisesMu.Lock()
	pendingBefore := len(env.b.pendingExercises[session.ID])
	env.b.pendingExercisesMu.Unlock()
	if pendingBefore != 2 {
		t.Fatalf("Expected 2 pending before callback, got %d", pendingBefore)
	}

	// Simulate a "done" callback for exercise 1
	cb := &tgbotapi.CallbackQuery{
		ID:   "cb1",
		Data: fmt.Sprintf("exercise_done_%d_1", session.ID),
		From: &tgbotapi.User{ID: userID},
		Message: &tgbotapi.Message{
			MessageID: 200,
			Chat:      &tgbotapi.Chat{ID: userID},
			Text:      "1. Exercise 1\n3 sets x 10 reps",
		},
	}

	env.b.handleExerciseCallback(cb, cb.Data)
	time.Sleep(50 * time.Millisecond)

	// Check that a new exercise prompt was sent (Exercise 4)
	foundNewPrompt := false
drainAfterDone:
	for {
		select {
		case msg := <-env.messageChan:
			if strings.Contains(msg, "Exercise 4") {
				foundNewPrompt = true
			}
		case <-time.After(10 * time.Millisecond):
			break drainAfterDone
		}
	}

	if !foundNewPrompt {
		t.Errorf("Expected next pending exercise (Exercise 4) to be sent after done callback")
	}

	// Pending should now be 1
	env.b.pendingExercisesMu.Lock()
	pendingAfter := len(env.b.pendingExercises[session.ID])
	env.b.pendingExercisesMu.Unlock()
	if pendingAfter != 1 {
		t.Errorf("Expected 1 pending exercise after done callback, got %d", pendingAfter)
	}
}

func TestExerciseCallback_EmptyPendingQueue_NoExtraMessages(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	userID := int64(123456)

	g, err := env.s.Workout.CreateGroup("G", "desc", false, userID, "[0]", "09:00", 15)
	if err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}
	order := 0
	v, err := env.s.Workout.CreateVariant(g.ID, "V", &order, "")
	if err != nil {
		t.Fatalf("CreateVariant: %v", err)
	}

	// Only 2 exercises - all sent immediately, no pending
	for i := 1; i <= 2; i++ {
		_, err := env.s.Workout.CreateExerciseInVariant(v.ID, fmt.Sprintf("Exercise %d", i), 3, 10, nil, nil, i)
		if err != nil {
			t.Fatalf("CreateExerciseInVariant %d: %v", i, err)
		}
	}

	session, err := env.s.Workout.CreateSession(g.ID, v.ID, userID, time.Now(), "09:00")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if err := env.b.workoutSvc.StartSession(session.ID); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	// Start exercise loop (sends 2, queues 0)
	env.b.startExerciseLoop(session.ID, v.ID, userID)
	time.Sleep(50 * time.Millisecond)

	// Drain all messages from the start
drainStart:
	for {
		select {
		case <-env.messageChan:
		case <-env.requestChan:
		case <-time.After(10 * time.Millisecond):
			break drainStart
		}
	}

	// Verify 0 pending
	env.b.pendingExercisesMu.Lock()
	pendingBefore := len(env.b.pendingExercises[session.ID])
	env.b.pendingExercisesMu.Unlock()
	if pendingBefore != 0 {
		t.Fatalf("Expected 0 pending exercises, got %d", pendingBefore)
	}

	// Simulate a "done" callback for exercise 1
	cb := &tgbotapi.CallbackQuery{
		ID:   "cb1",
		Data: fmt.Sprintf("exercise_done_%d_1", session.ID),
		From: &tgbotapi.User{ID: userID},
		Message: &tgbotapi.Message{
			MessageID: 200,
			Chat:      &tgbotapi.Chat{ID: userID},
			Text:      "1. Exercise 1\n3 sets x 10 reps",
		},
	}

	env.b.handleExerciseCallback(cb, cb.Data)
	time.Sleep(50 * time.Millisecond)

	// Count messages after the callback: should only see the edit (Completed) + completion check messages, no new exercise prompts
	newExercisePromptSent := false
drainAfterDone:
	for {
		select {
		case msg := <-env.messageChan:
			// A new exercise prompt would contain exercise callback buttons (exercise_done_)
			if strings.Contains(msg, "exercise_done_") {
				newExercisePromptSent = true
			}
		case <-time.After(10 * time.Millisecond):
			break drainAfterDone
		}
	}

	if newExercisePromptSent {
		t.Errorf("Expected no new exercise prompt to be sent when pending queue is empty")
	}
}
