package bot

import (
	"fmt"
	"log"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

// SendExerciseList sends an inline keyboard with all available exercises for a user
func (b *Bot) SendExerciseList(sessionID int64, chatID int64) (int, error) {
	// Get session to verify it's in_progress and get user ID
	session, err := b.store.GetWorkoutSession(sessionID)
	if err != nil || session == nil {
		return 0, fmt.Errorf("session not found")
	}

	if session.Status != "in_progress" && session.Status != "completed" {
		return 0, fmt.Errorf("session is not active")
	}

	// Get all unique exercises for this user
	exercises, err := b.store.GetAllUniqueExercises(session.UserID)
	if err != nil {
		return 0, fmt.Errorf("failed to get exercises: %w", err)
	}

	if len(exercises) == 0 {
		msg := tgbotapi.NewMessage(chatID, "No exercises found in your workouts.")
		sentMsg, err := b.api.Send(msg)
		if err != nil {
			return 0, err
		}
		return sentMsg.MessageID, nil
	}

	// Build exercise list with inline buttons
	var rows [][]tgbotapi.InlineKeyboardButton
	for _, ex := range exercises {
		// Format exercise label with details
		label := ex.ExerciseName

		// Add sets and reps info
		repsStr := fmt.Sprintf("%d", ex.TargetRepsMin)
		if ex.TargetRepsMax != nil && *ex.TargetRepsMax != ex.TargetRepsMin {
			repsStr = fmt.Sprintf("%d-%d", ex.TargetRepsMin, *ex.TargetRepsMax)
		}
		label += fmt.Sprintf(" (%d×%s", ex.TargetSets, repsStr)

		// Add weight if present
		if ex.TargetWeightKg != nil {
			label += fmt.Sprintf(" @ %.0fkg", *ex.TargetWeightKg)
		}
		label += ")"

		// Create callback button
		callbackData := fmt.Sprintf("select_exercise_%d_%d", sessionID, ex.ID)
		btn := tgbotapi.NewInlineKeyboardButtonData(label, callbackData)
		rows = append(rows, tgbotapi.NewInlineKeyboardRow(btn))
	}

	keyboard := tgbotapi.NewInlineKeyboardMarkup(rows...)
	msg := tgbotapi.NewMessage(chatID, "**Select exercise to add:**")
	msg.ParseMode = "Markdown"
	msg.ReplyMarkup = keyboard

	sentMsg, err := b.api.Send(msg)
	if err != nil {
		return 0, err
	}

	return sentMsg.MessageID, nil
}

// handleAddExerciseCallback shows the list of all exercises
func (b *Bot) handleAddExerciseCallback(cb *tgbotapi.CallbackQuery, sessionID int64) {
	// Send exercise list
	_, err := b.SendExerciseList(sessionID, cb.Message.Chat.ID)
	if err != nil {
		log.Printf("Failed to send exercise list: %v", err)
		b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error loading exercises."))
		return
	}

	// Remove the "Add Exercise" button from the completion message
	edit := tgbotapi.NewEditMessageReplyMarkup(cb.Message.Chat.ID, cb.Message.MessageID, tgbotapi.InlineKeyboardMarkup{
		InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{},
	})
	b.api.Send(edit)
}

// handleSelectExerciseCallback adds the selected exercise to the session
func (b *Bot) handleSelectExerciseCallback(cb *tgbotapi.CallbackQuery, sessionID, exerciseID int64) {
	// Get exercise details
	exercise, err := b.store.GetWorkoutExercise(exerciseID)
	if err != nil || exercise == nil {
		b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Exercise not found."))
		return
	}

	// Delete the exercise list message
	b.api.Send(tgbotapi.NewDeleteMessage(cb.Message.Chat.ID, cb.Message.MessageID))

	// Send exercise prompt for the selected exercise
	// Use a counter to display the exercise number (we'll just use a generic number)
	_, err = b.SendExercisePrompt(sessionID, exerciseID, exercise.ExerciseName,
		exercise.TargetSets, exercise.TargetRepsMin, exercise.TargetRepsMax, exercise.TargetWeightKg)
	if err != nil {
		log.Printf("Failed to send exercise prompt: %v", err)
		b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error adding exercise."))
	}
}
