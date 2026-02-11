package bot

import (
	"fmt"
	"log"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

// SendExerciseList sends an inline keyboard with all available exercises for a user
// Uses pagination to avoid Telegram keyboard limits (max 100 buttons)
func (b *Bot) SendExerciseList(sessionID int64, chatID int64) (int, error) {
	return b.sendExerciseListPage(sessionID, chatID, 0)
}

// sendExerciseListPage sends a specific page of the exercise list
func (b *Bot) sendExerciseListPage(sessionID int64, chatID int64, page int) (int, error) {
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

	// Pagination: 10 exercises per page to stay well under Telegram's limits
	const exercisesPerPage = 10
	totalPages := (len(exercises) + exercisesPerPage - 1) / exercisesPerPage

	// Clamp page to valid range
	if page < 0 {
		page = 0
	}
	if page >= totalPages {
		page = totalPages - 1
	}

	// Calculate slice boundaries
	startIdx := page * exercisesPerPage
	endIdx := startIdx + exercisesPerPage
	if endIdx > len(exercises) {
		endIdx = len(exercises)
	}

	pageExercises := exercises[startIdx:endIdx]

	// Build exercise list with inline buttons
	var rows [][]tgbotapi.InlineKeyboardButton
	for _, ex := range pageExercises {
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

		// Truncate label to stay within Telegram limits (callback_data max is 64 bytes)
		// Keep button text reasonable - aim for max 60 chars to be safe
		if len(label) > 60 {
			label = label[:57] + "..."
		}

		// Create callback button
		callbackData := fmt.Sprintf("select_exercise_%d_%d", sessionID, ex.ID)
		btn := tgbotapi.NewInlineKeyboardButtonData(label, callbackData)
		rows = append(rows, tgbotapi.NewInlineKeyboardRow(btn))
	}

	// Add pagination buttons if needed
	if totalPages > 1 {
		var paginationRow []tgbotapi.InlineKeyboardButton

		if page > 0 {
			prevCallback := fmt.Sprintf("exercise_page_%d_%d", sessionID, page-1)
			paginationRow = append(paginationRow,
				tgbotapi.NewInlineKeyboardButtonData("◀️ Previous", prevCallback))
		}

		// Page indicator
		pageInfo := fmt.Sprintf("Page %d/%d", page+1, totalPages)
		// Use a dummy callback that we'll ignore
		paginationRow = append(paginationRow,
			tgbotapi.NewInlineKeyboardButtonData(pageInfo, fmt.Sprintf("page_info_%d", page)))

		if page < totalPages-1 {
			nextCallback := fmt.Sprintf("exercise_page_%d_%d", sessionID, page+1)
			paginationRow = append(paginationRow,
				tgbotapi.NewInlineKeyboardButtonData("Next ▶️", nextCallback))
		}

		rows = append(rows, paginationRow)
	}

	keyboard := tgbotapi.NewInlineKeyboardMarkup(rows...)
	text := "**Select exercise to add:**"
	if totalPages > 1 {
		text = fmt.Sprintf("**Select exercise to add** (Page %d/%d):", page+1, totalPages)
	}

	msg := tgbotapi.NewMessage(chatID, text)
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

// handleExercisePageCallback handles pagination for the exercise list
func (b *Bot) handleExercisePageCallback(cb *tgbotapi.CallbackQuery, sessionID int64, page int) {
	// Update the message with the new page
	_, err := b.sendExerciseListPage(sessionID, cb.Message.Chat.ID, page)
	if err != nil {
		log.Printf("Failed to send exercise page: %v", err)
		return
	}

	// Delete the old message
	b.api.Send(tgbotapi.NewDeleteMessage(cb.Message.Chat.ID, cb.Message.MessageID))
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
