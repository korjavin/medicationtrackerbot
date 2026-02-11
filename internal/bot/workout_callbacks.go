package bot

import (
	"fmt"
	"log"
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
	}

	sessionID, err := strconv.ParseInt(sessionIDStr, 10, 64)
	if err != nil {
		log.Printf("Invalid session ID: %v", err)
		return
	}

	session, err := b.store.GetWorkoutSession(sessionID)
	if err != nil || session == nil {
		b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Workout session not found."))
		return
	}

	// Get group info for rotation handling
	group, err := b.store.GetWorkoutGroup(session.GroupID)
	if err != nil || group == nil {
		log.Printf("Failed to get workout group: %v", err)
		return
	}

	switch action {
	case "start":
		// Mark session as in_progress
		if err := b.store.StartSession(sessionID); err != nil {
			log.Printf("Failed to start session: %v", err)
			b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error starting workout."))
			return
		}

		// Remove buttons from notification
		edit := tgbotapi.NewEditMessageReplyMarkup(cb.Message.Chat.ID, cb.Message.MessageID, tgbotapi.InlineKeyboardMarkup{
			InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{},
		})
		b.api.Send(edit)

		// Start exercise-by-exercise prompts
		b.startExerciseLoop(sessionID, session.VariantID, cb.Message.Chat.ID)

	case "snooze1":
		if err := b.store.SnoozeSession(sessionID, 1*time.Hour); err != nil {
			log.Printf("Failed to snooze session: %v", err)
			b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error snoozing workout."))
			return
		}
		// Delete notification
		b.api.Send(tgbotapi.NewDeleteMessage(cb.Message.Chat.ID, cb.Message.MessageID))

	case "snooze2":
		if err := b.store.SnoozeSession(sessionID, 2*time.Hour); err != nil {
			log.Printf("Failed to snooze session: %v", err)
			b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error snoozing workout."))
			return
		}
		// Delete notification
		b.api.Send(tgbotapi.NewDeleteMessage(cb.Message.Chat.ID, cb.Message.MessageID))

	case "skip":
		if err := b.store.SkipSession(sessionID); err != nil {
			log.Printf("Failed to skip session: %v", err)
			b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error skipping workout."))
			return
		}

		// Advance rotation if applicable
		if group.IsRotating {
			if err := b.store.AdvanceRotation(group.ID); err != nil {
				log.Printf("Failed to advance rotation: %v", err)
			}
		}
		// Delete notification
		b.api.Send(tgbotapi.NewDeleteMessage(cb.Message.Chat.ID, cb.Message.MessageID))
	}
}

// startExerciseLoop sends exercise prompts one by one
func (b *Bot) startExerciseLoop(sessionID, variantID int64, chatID int64) {
	exercises, err := b.store.ListExercisesByVariant(variantID)
	if err != nil || len(exercises) == 0 {
		b.api.Send(tgbotapi.NewMessage(chatID, "❌ No exercises found for this workout."))
		return
	}

	b.api.Send(tgbotapi.NewMessage(chatID, fmt.Sprintf("🏋️ **Workout Started**\n\n%d exercises to complete:", len(exercises))))

	for i, ex := range exercises {
		_, err := b.SendExercisePrompt(sessionID, ex.ID, fmt.Sprintf("%d. %s", i+1, ex.ExerciseName),
			ex.TargetSets, ex.TargetRepsMin, ex.TargetRepsMax, ex.TargetWeightKg)
		if err != nil {
			log.Printf("Failed to send exercise prompt: %v", err)
		}
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
	sessionID, _ := strconv.ParseInt(parts[2], 10, 64)
	exerciseID, _ := strconv.ParseInt(parts[3], 10, 64)

	exercise, err := b.store.GetWorkoutExercise(exerciseID)
	if err != nil || exercise == nil {
		b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Exercise not found."))
		return
	}

	switch action {
	case "done":
		// Log exercise with default values
		_, err := b.store.LogExercise(sessionID, exerciseID, exercise.ExerciseName,
			&exercise.TargetSets, &exercise.TargetRepsMin, exercise.TargetWeightKg, "completed", "")
		if err != nil {
			log.Printf("Failed to log exercise: %v", err)
			b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error logging exercise."))
			return
		}

		// Update message
		editText := tgbotapi.NewEditMessageText(cb.Message.Chat.ID, cb.Message.MessageID,
			cb.Message.Text+"\n\n✅ Completed")
		editText.ParseMode = "Markdown"
		b.api.Send(editText)

		// Remove buttons
		edit := tgbotapi.NewEditMessageReplyMarkup(cb.Message.Chat.ID, cb.Message.MessageID, tgbotapi.InlineKeyboardMarkup{
			InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{},
		})
		b.api.Send(edit)

		// Check if all exercises are done
		b.checkWorkoutCompletion(sessionID, cb.Message.Chat.ID)

	case "skip":
		// Log exercise as skipped
		_, err := b.store.LogExercise(sessionID, exerciseID, exercise.ExerciseName,
			nil, nil, nil, "skipped", "")
		if err != nil {
			log.Printf("Failed to log skipped exercise: %v", err)
			return
		}

		// Update message
		editText := tgbotapi.NewEditMessageText(cb.Message.Chat.ID, cb.Message.MessageID,
			cb.Message.Text+"\n\n⏭ Skipped")
		editText.ParseMode = "Markdown"
		b.api.Send(editText)

		// Remove buttons
		edit := tgbotapi.NewEditMessageReplyMarkup(cb.Message.Chat.ID, cb.Message.MessageID, tgbotapi.InlineKeyboardMarkup{
			InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{},
		})
		b.api.Send(edit)

		// Check if all exercises are done
		b.checkWorkoutCompletion(sessionID, cb.Message.Chat.ID)

	case "edit":
		// For now, send a simple message asking for input
		// In a more complete implementation, you'd enter an input mode
		_, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID,
			"To edit, please use the web interface for now. Click 'Menu' to open the app."))
		if err != nil {
			log.Printf("Failed to send edit message: %v", err)
		}

		// Log with default values for now
		_, err = b.store.LogExercise(sessionID, exerciseID, exercise.ExerciseName,
			&exercise.TargetSets, &exercise.TargetRepsMin, exercise.TargetWeightKg, "completed", "")
		if err != nil {
			log.Printf("Failed to log exercise: %v", err)
		}

		// Update original message
		editText := tgbotapi.NewEditMessageText(cb.Message.Chat.ID, cb.Message.MessageID,
			cb.Message.Text+"\n\n✅ Logged (edit in web app)")
		editText.ParseMode = "Markdown"
		b.api.Send(editText)

		// Remove buttons
		edit := tgbotapi.NewEditMessageReplyMarkup(cb.Message.Chat.ID, cb.Message.MessageID, tgbotapi.InlineKeyboardMarkup{
			InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{},
		})
		b.api.Send(edit)

		// Check completion
		b.checkWorkoutCompletion(sessionID, cb.Message.Chat.ID)
	}
}

// checkWorkoutCompletion checks if all exercises are done and completes the session
func (b *Bot) checkWorkoutCompletion(sessionID int64, chatID int64) {
	session, err := b.store.GetWorkoutSession(sessionID)
	if err != nil || session == nil {
		return
	}

	// Get all exercises for this variant
	exercises, err := b.store.ListExercisesByVariant(session.VariantID)
	if err != nil {
		return
	}

	// Get logged exercises
	logs, err := b.store.GetExerciseLogs(sessionID)
	if err != nil {
		return
	}

	// If all exercises have logs, complete the session
	// Fix: Ensure we have at least one completed/skipped log for EVERY exercise in the variant
	allExercisesHandled := true

	// Track which exercises are handled (completed or skipped) and which are actually completed
	handledExerciseIDs := make(map[int64]bool)
	completedExerciseIDs := make(map[int64]bool)

	for _, log := range logs {
		if log.Status == "completed" || log.Status == "skipped" {
			handledExerciseIDs[log.ExerciseID] = true
		}
		if log.Status == "completed" {
			completedExerciseIDs[log.ExerciseID] = true
		}
	}

	// Check if every variant exercise is handled
	for _, ex := range exercises {
		if !handledExerciseIDs[ex.ID] {
			allExercisesHandled = false
			break
		}
	}

	if allExercisesHandled {
		// Only update DB status and advance rotation if not already completed
		if session.Status != "completed" {
			if err := b.store.CompleteSession(sessionID); err != nil {
				log.Printf("Failed to complete session: %v", err)
				return
			}

			// Advance rotation if applicable
			group, err := b.store.GetWorkoutGroup(session.GroupID)
			if err == nil && group != nil && group.IsRotating {
				if err := b.store.AdvanceRotation(group.ID); err != nil {
					log.Printf("Failed to advance rotation: %v", err)
				}
			}
		}

		// Count completed exercises (unique, only "completed" status)
		completedCount := 0
		for _, ex := range exercises {
			if completedExerciseIDs[ex.ID] {
				completedCount++
			}
		}

		// Send completion message (always, so users can add more exercises)
		b.SendWorkoutComplete(sessionID, completedCount, len(exercises))
	}
}
