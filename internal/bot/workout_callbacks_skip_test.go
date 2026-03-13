package bot

import (
	"strings"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

func TestExerciseCallback_DoneAndSkip_NoParseMode(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	userID := int64(123456)

	// Create test data
	g, _ := env.s.CreateWorkoutGroup("G", "desc", false, userID, "[0]", "09:00", 15)
	order := 0
	v, _ := env.s.CreateWorkoutVariant(g.ID, "V", &order, "")
	ex, _ := env.s.AddExerciseToVariant(v.ID, "Test Exercise", 3, 10, nil, nil, 1)

	session, _ := env.s.CreateWorkoutSession(g.ID, v.ID, userID, time.Now(), "09:00")
	env.b.workoutSvc.StartSession(session.ID)

	cb1 := &tgbotapi.CallbackQuery{
		ID:   "cb1",
		Data: "exercise_done_1_1",
		From: &tgbotapi.User{ID: userID},
		Message: &tgbotapi.Message{
			MessageID: 100,
			Chat:      &tgbotapi.Chat{ID: userID},
			Text:      "1. Test Exercise\n3 sets x 10 reps",
		},
	}

	env.b.handleExerciseCallback(cb1, cb1.Data)

	time.Sleep(50 * time.Millisecond)

	requestCount := 0
	foundEdit := false
drainLoop:
	for {
		select {
		case req := <-env.requestChan:
			requestCount++
			if strings.Contains(req, "editMessageText") {
				foundEdit = true
				if strings.Contains(req, "parse_mode=Markdown") {
					t.Errorf("Expected ParseMode to be empty, got 'Markdown' in request: %s", req)
				}
				if !strings.Contains(req, "✅ Completed") {
					t.Errorf("Expected ✅ Completed in text, got request: %s", req)
				}
				if !strings.Contains(req, "reply_markup={\"inline_keyboard\":[]}") {
					t.Errorf("Expected empty inline keyboard reply markup in EditMessageText, got: %s", req)
				}
			}
		case <-time.After(10 * time.Millisecond):
			break drainLoop
		}
	}

	if !foundEdit {
		t.Errorf("Expected EditMessageText request")
	}

	log, _ := env.s.GetExerciseLogBySessionAndExercise(session.ID, ex.ID)
	if log == nil || log.Status != "completed" {
		t.Errorf("Expected exercise to be logged as completed")
	}
}
