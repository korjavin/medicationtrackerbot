package bot

import (
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

// handleWorkoutCallback handles workout session actions (start, snooze, skip)
func (b *Bot) handleWorkoutCallback(cb *tgbotapi.CallbackQuery, data string) {
	// Parse callback data: workout_start_123, workout_snooze1_123, workout_snooze2_123, workout_skip_123
	var action string
	var sessionIDStr string

	if strings.HasPrefix(data, "workout_start_") {
		action = "start"
		sessionIDStr = data[14:]
	} else if strings.HasPrefix(data, "workout_snooze1_") {
		action = "snooze1"
		sessionIDStr = data[16:]
	} else if strings.HasPrefix(data, "workout_snooze2_") {
		action = "snooze2"
		sessionIDStr = data[16:]
	} else if strings.HasPrefix(data, "workout_skip_") {
		action = "skip"
		sessionIDStr = data[13:]
	} else if strings.HasPrefix(data, "workout_finish_") {
		action = "finish"
		sessionIDStr = data[15:]
	}

	sessionID, err := strconv.ParseInt(sessionIDStr, 10, 64)
	if err != nil {
		slog.Error("Invalid session ID", "error", err)
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Invalid callback data.")); err != nil {
			slog.Error("send failed", "error", err)
		}
		return
	}

	session, err := b.workouts.GetWorkoutSession(sessionID)
	if err != nil || session == nil {
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Workout session not found.")); err != nil {
			slog.Error("send failed", "error", err)
		}
		return
	}

	// Verify the user owns this session
	if session.UserID != cb.From.ID {
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Unauthorized: this session belongs to another user.")); err != nil {
			slog.Error("send failed", "error", err)
		}
		return
	}

	switch action {
	case "start":
		// Mark session as in_progress and clear any snooze
		if err := b.workoutSvc.StartSession(sessionID); err != nil {
			slog.Error("Failed to start session", "error", err)
			if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error starting workout.")); err != nil {
				slog.Error("send failed", "error", err)
			}
			return
		}

		// Remove buttons from notification
		edit := tgbotapi.NewEditMessageReplyMarkup(cb.Message.Chat.ID, cb.Message.MessageID, tgbotapi.InlineKeyboardMarkup{
			InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{},
		})
		if _, err := b.api.Send(edit); err != nil {
			slog.Error("send failed", "error", err)
		}
		b.trackWorkoutMessage(sessionID, cb.Message.MessageID)

		// Start exercise-by-exercise prompts
		b.startExerciseLoop(sessionID, session.VariantID, cb.Message.Chat.ID)

	case "snooze1":
		if err := b.workoutSvc.SnoozeSession(sessionID, 1*time.Hour); err != nil {
			slog.Error("Failed to snooze session", "error", err)
			if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error snoozing workout.")); err != nil {
				slog.Error("send failed", "error", err)
			}
			return
		}
		// Delete notification
		if _, err := b.api.Request(tgbotapi.NewDeleteMessage(cb.Message.Chat.ID, cb.Message.MessageID)); err != nil {
			slog.Error("send failed", "error", err)
		}

	case "snooze2":
		if err := b.workoutSvc.SnoozeSession(sessionID, 2*time.Hour); err != nil {
			slog.Error("Failed to snooze session", "error", err)
			if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error snoozing workout.")); err != nil {
				slog.Error("send failed", "error", err)
			}
			return
		}
		// Delete notification
		if _, err := b.api.Request(tgbotapi.NewDeleteMessage(cb.Message.Chat.ID, cb.Message.MessageID)); err != nil {
			slog.Error("send failed", "error", err)
		}

	case "skip":
		// Service handles skip + rotation advancement for rotating groups
		if err := b.workoutSvc.SkipSession(sessionID); err != nil {
			slog.Error("Failed to skip session", "error", err)
			if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error skipping workout.")); err != nil {
				slog.Error("send failed", "error", err)
			}
			return
		}
		// Delete notification
		if _, err := b.api.Request(tgbotapi.NewDeleteMessage(cb.Message.Chat.ID, cb.Message.MessageID)); err != nil {
			slog.Error("send failed", "error", err)
		}
		b.ClearPendingExercises(sessionID)
		if err := b.CleanupWorkoutSessionMessages(sessionID); err != nil {
			slog.Error("Failed to cleanup workout messages", "error", err)
		}

	case "finish":
		// User explicitly finished the workout; service handles complete + rotation advancement
		if session.Status != "completed" {
			if err := b.workoutSvc.CompleteSession(sessionID); err != nil {
				slog.Error("Failed to complete session", "error", err)
				if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error saving workout.")); err != nil {
					slog.Error("send failed", "error", err)
				}
				return
			}
		}

		// Remove buttons
		edit := tgbotapi.NewEditMessageReplyMarkup(cb.Message.Chat.ID, cb.Message.MessageID, tgbotapi.InlineKeyboardMarkup{
			InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{},
		})
		if _, err := b.api.Send(edit); err != nil {
			slog.Error("send failed", "error", err)
		}

		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "👍 Workout saved.")); err != nil {
			slog.Error("send failed", "error", err)
		}
		b.ClearPendingExercises(sessionID)
		if err := b.CleanupWorkoutSessionMessages(sessionID); err != nil {
			slog.Error("Failed to cleanup workout messages", "error", err)
		}
	}
}

// maxOpenExercisePrompts is the maximum number of exercise prompts shown at once.
const maxOpenExercisePrompts = 3

// startExerciseLoop sends the first batch of exercise prompts and queues the rest.
func (b *Bot) startExerciseLoop(sessionID, variantID int64, chatID int64) {
	exercises, err := b.workouts.ListExercisesByVariant(variantID)
	if err != nil || len(exercises) == 0 {
		if _, err := b.api.Send(tgbotapi.NewMessage(chatID, "❌ No exercises found for this workout.")); err != nil {
			slog.Error("send failed", "error", err)
		}
		return
	}

	total := len(exercises)
	sendCount := total
	if sendCount > maxOpenExercisePrompts {
		sendCount = maxOpenExercisePrompts
	}

	// Build start message
	startText := fmt.Sprintf("🏋️ **Workout Started**\n\n%d exercises to complete:", total)
	if total > maxOpenExercisePrompts {
		startText = fmt.Sprintf("🏋️ **Workout Started**\n\n%d exercises to complete (showing first %d):", total, sendCount)
	}

	startMsg, err := b.api.Send(tgbotapi.NewMessage(chatID, startText))
	if err != nil {
		slog.Error("send failed", "error", err)
	} else {
		b.trackWorkoutMessage(sessionID, startMsg.MessageID)
	}

	// Send first batch
	for i := 0; i < sendCount; i++ {
		ex := exercises[i]
		_, err := b.SendExercisePrompt(sessionID, ex.ID, fmt.Sprintf("%d. %s", i+1, ex.ExerciseName),
			ex.TargetSets, ex.TargetRepsMin, ex.TargetRepsMax, ex.TargetWeightKg)
		if err != nil {
			slog.Error("Failed to send exercise prompt", "error", err)
		}
	}

	// Queue remaining exercises
	if sendCount < total {
		pending := make([]pendingExercise, 0, total-sendCount)
		for i := sendCount; i < total; i++ {
			ex := exercises[i]
			pending = append(pending, pendingExercise{
				Index:          i + 1,
				ExerciseID:     ex.ID,
				ExerciseName:   ex.ExerciseName,
				TargetSets:     ex.TargetSets,
				TargetRepsMin:  ex.TargetRepsMin,
				TargetRepsMax:  ex.TargetRepsMax,
				TargetWeightKg: ex.TargetWeightKg,
			})
		}
		b.pendingExercisesMu.Lock()
		if b.pendingExercises == nil {
			b.pendingExercises = make(map[int64][]pendingExercise)
		}
		b.pendingExercises[sessionID] = pending
		b.pendingExercisesMu.Unlock()
	}
}

// handleExerciseCallback handles exercise actions (done, edit, skip)
func (b *Bot) handleExerciseCallback(cb *tgbotapi.CallbackQuery, data string) {
	// Parse: exercise_done_123_456, exercise_edit_123_456, exercise_skip_123_456
	parts := strings.Split(data, "_")
	if len(parts) < 4 {
		return
	}

	action := parts[1] // done, edit, skip
	sessionID, err := strconv.ParseInt(parts[2], 10, 64)
	if err != nil {
		slog.Error("Failed to parse session ID from callback data", "error", err)
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Invalid callback data.")); err != nil {
			slog.Error("send failed", "error", err)
		}
		return
	}
	// Exercise ID may have an "L" prefix indicating a library-sourced exercise.
	// This prevents cross-table ID collisions between exercise_library and workout_exercises.
	exerciseIDStr := parts[3]
	fromLibrary := false
	if strings.HasPrefix(exerciseIDStr, "L") {
		fromLibrary = true
		exerciseIDStr = exerciseIDStr[1:]
	}
	exerciseID, err := strconv.ParseInt(exerciseIDStr, 10, 64)
	if err != nil {
		slog.Error("Failed to parse exercise ID from callback data", "error", err)
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Invalid callback data.")); err != nil {
			slog.Error("send failed", "error", err)
		}
		return
	}

	// Verify the user owns this session and it is still in progress
	session, err := b.workouts.GetWorkoutSession(sessionID)
	if err != nil || session == nil || session.UserID != cb.From.ID {
		slog.Error("Session not found or unauthorized", "sessionID", sessionID, "userID", cb.From.ID)
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Unauthorized: this session belongs to another user.")); err != nil {
			slog.Error("send failed", "error", err)
		}
		return
	}
	if session.Status != "in_progress" {
		slog.Info("Ignoring exercise callback for non-in_progress session", "sessionID", sessionID, "status", session.Status)
		return
	}

	switch action {
	case "done":
		changed, err := b.exerciseSvc.LogExercise(sessionID, exerciseID, "completed", fromLibrary)
		if err != nil {
			slog.Error("Failed to log exercise", "error", err)
			if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error logging exercise.")); err != nil {
				slog.Error("send failed", "error", err)
			}
			return
		}

		editText := tgbotapi.NewEditMessageText(cb.Message.Chat.ID, cb.Message.MessageID,
			cb.Message.Text+"\n\n✅ Completed")
		// Remove ParseMode so that unescaped characters in the exercise name do not break the request (cb.Message.Text is already stripped of Markdown)
		emptyMarkup := tgbotapi.InlineKeyboardMarkup{InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{}}
		editText.ReplyMarkup = &emptyMarkup
		if _, err := b.api.Send(editText); err != nil {
			slog.Error("send failed: edit message text", "error", err)
		}

		if changed {
			b.sendNextPendingExercise(sessionID)
			b.checkWorkoutCompletion(sessionID, cb.Message.Chat.ID)
		}

	case "skip":
		changed, err := b.exerciseSvc.LogExercise(sessionID, exerciseID, "skipped", fromLibrary)
		if err != nil {
			slog.Error("Failed to log skipped exercise", "error", err)
			if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error logging exercise.")); err != nil {
				slog.Error("send failed", "error", err)
			}
			return
		}

		editText := tgbotapi.NewEditMessageText(cb.Message.Chat.ID, cb.Message.MessageID,
			cb.Message.Text+"\n\n⏭ Skipped")
		emptyMarkup := tgbotapi.InlineKeyboardMarkup{InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{}}
		editText.ReplyMarkup = &emptyMarkup
		if _, err := b.api.Send(editText); err != nil {
			slog.Error("send failed: edit message text", "error", err)
		}

		if changed {
			b.sendNextPendingExercise(sessionID)
			b.checkWorkoutCompletion(sessionID, cb.Message.Chat.ID)
		}

	case "edit":
		changed, err := b.exerciseSvc.LogExercise(sessionID, exerciseID, "completed", fromLibrary)
		if err != nil {
			slog.Error("Failed to log exercise (edit)", "error", err)
			if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error logging exercise.")); err != nil {
				slog.Error("send failed", "error", err)
			}
			return
		}

		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID,
			"To edit, please use the web interface for now. Click 'Menu' to open the app.")); err != nil {
			slog.Error("Failed to send edit message", "error", err)
		}

		editText := tgbotapi.NewEditMessageText(cb.Message.Chat.ID, cb.Message.MessageID,
			cb.Message.Text+"\n\n✅ Logged (edit in web app)")
		emptyMarkup := tgbotapi.InlineKeyboardMarkup{InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{}}
		editText.ReplyMarkup = &emptyMarkup
		if _, err := b.api.Send(editText); err != nil {
			slog.Error("send failed: edit message text", "error", err)
		}

		if changed {
			b.sendNextPendingExercise(sessionID)
			b.checkWorkoutCompletion(sessionID, cb.Message.Chat.ID)
		}
	}
}

// sendNextPendingExercise pops one exercise from the pending queue for the given
// session and sends its prompt. Called after each done/skip/edit callback so the
// user always has one new prompt to act on.
func (b *Bot) sendNextPendingExercise(sessionID int64) {
	b.pendingExercisesMu.Lock()
	queue := b.pendingExercises[sessionID]
	if len(queue) == 0 {
		b.pendingExercisesMu.Unlock()
		return
	}
	next := queue[0]
	b.pendingExercises[sessionID] = queue[1:]
	if len(b.pendingExercises[sessionID]) == 0 {
		delete(b.pendingExercises, sessionID)
	}
	b.pendingExercisesMu.Unlock()

	// Re-check session status to avoid sending prompts for sessions that were
	// completed/skipped via the web while a Telegram callback was in flight.
	session, err := b.workouts.GetWorkoutSession(sessionID)
	if err != nil {
		// Transient failure — re-insert the exercise so it's not permanently lost.
		slog.Error("Failed to re-check session for pending exercise, re-queuing", "error", err, "sessionID", sessionID)
		b.pendingExercisesMu.Lock()
		if b.pendingExercises == nil {
			b.pendingExercises = make(map[int64][]pendingExercise)
		}
		b.pendingExercises[sessionID] = append([]pendingExercise{next}, b.pendingExercises[sessionID]...)
		b.pendingExercisesMu.Unlock()
		return
	}
	if session == nil || session.Status != "in_progress" {
		return
	}

	_, err = b.SendExercisePrompt(sessionID, next.ExerciseID,
		fmt.Sprintf("%d. %s", next.Index, next.ExerciseName),
		next.TargetSets, next.TargetRepsMin, next.TargetRepsMax, next.TargetWeightKg)
	if err != nil {
		slog.Error("Failed to send pending exercise prompt, re-queuing", "error", err, "sessionID", sessionID, "exerciseID", next.ExerciseID)
		b.pendingExercisesMu.Lock()
		if b.pendingExercises == nil {
			b.pendingExercises = make(map[int64][]pendingExercise)
		}
		b.pendingExercises[sessionID] = append([]pendingExercise{next}, b.pendingExercises[sessionID]...)
		b.pendingExercisesMu.Unlock()
	}
}

// ClearPendingExercises removes any remaining pending exercises for the session.
// Exported so that the web handler can clear the queue when a session is
// completed or skipped via the API.
func (b *Bot) ClearPendingExercises(sessionID int64) {
	b.pendingExercisesMu.Lock()
	delete(b.pendingExercises, sessionID)
	b.pendingExercisesMu.Unlock()
}

// checkWorkoutCompletion checks if all exercises are done and prompts the user to finish.
func (b *Bot) checkWorkoutCompletion(sessionID int64, chatID int64) {
	session, err := b.workouts.GetWorkoutSession(sessionID)
	if err != nil || session == nil {
		return
	}
	// Don't send a finish card if the session was already completed/skipped
	// (e.g. via the web API while the Telegram callback was in flight).
	if session.Status != "in_progress" {
		return
	}

	done, completedCount, totalCount, err := b.exerciseSvc.CheckSessionCompletion(sessionID, session.VariantID)
	if err != nil {
		slog.Error("checkWorkoutCompletion error", "error", err)
		return
	}

	if done && totalCount > 0 {
		if err := b.SendWorkoutComplete(chatID, sessionID, completedCount, totalCount); err != nil {
			slog.Error("send failed", "error", err)
		}
	}
}
