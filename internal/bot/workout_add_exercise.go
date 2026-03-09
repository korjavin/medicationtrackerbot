package bot

import (
	"fmt"
	"log/slog"

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
	session, err := b.workouts.GetWorkoutSession(sessionID)
	if err != nil || session == nil {
		return 0, fmt.Errorf("session not found")
	}

	if session.Status != "in_progress" && session.Status != "completed" {
		return 0, fmt.Errorf("session is not active")
	}

	// Get all unique exercises for this user
	exercises, err := b.workouts.GetAllUniqueExercises(session.UserID)
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
		// Use rune-based truncation to avoid splitting UTF-8 characters
		if len([]rune(label)) > 60 {
			runes := []rune(label)
			label = string(runes[:57]) + "..."
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

	// Always add a Cancel button so the user can back out without being forced to select
	cancelCallback := fmt.Sprintf("cancel_add_exercise_%d", sessionID)
	rows = append(rows, tgbotapi.NewInlineKeyboardRow(
		tgbotapi.NewInlineKeyboardButtonData("❌ Cancel", cancelCallback),
	))

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
	// Validation: Get and verify session ownership
	session, err := b.workouts.GetWorkoutSession(sessionID)
	if err != nil || session == nil {
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Session not found.")); err != nil {
			slog.Error("send failed", "error", err)
		}
		return
	}

	// Validation: Verify session belongs to the callback sender
	if session.UserID != cb.From.ID {
		slog.Warn("Security: Unauthorized access to exercise list", "userID", cb.From.ID, "sessionID", sessionID, "ownerID", session.UserID)
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Access denied.")); err != nil {
			slog.Error("send failed", "error", err)
		}
		return
	}

	// Send exercise list
	_, err = b.SendExerciseList(sessionID, cb.Message.Chat.ID)
	if err != nil {
		slog.Error("Failed to send exercise list", "error", err)
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error loading exercises.")); err != nil {
			slog.Error("send failed", "error", err)
		}
		return
	}

	// Remove the "Add Exercise" button from the completion message
	edit := tgbotapi.NewEditMessageReplyMarkup(cb.Message.Chat.ID, cb.Message.MessageID, tgbotapi.InlineKeyboardMarkup{
		InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{},
	})
	if _, err := b.api.Send(edit); err != nil {
		slog.Error("send failed", "error", err)
	}
}

// handleExercisePageCallback handles pagination for the exercise list
func (b *Bot) handleExercisePageCallback(cb *tgbotapi.CallbackQuery, sessionID int64, page int) {
	// Validation: Get and verify session ownership
	session, err := b.workouts.GetWorkoutSession(sessionID)
	if err != nil || session == nil {
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Session not found.")); err != nil {
			slog.Error("send failed", "error", err)
		}
		return
	}

	// Validation: Verify session belongs to the callback sender
	if session.UserID != cb.From.ID {
		slog.Warn("Security: Unauthorized access to exercise list pagination", "userID", cb.From.ID, "sessionID", sessionID, "ownerID", session.UserID)
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Access denied.")); err != nil {
			slog.Error("send failed", "error", err)
		}
		return
	}

	// Update the message with the new page
	_, err = b.sendExerciseListPage(sessionID, cb.Message.Chat.ID, page)
	if err != nil {
		slog.Error("Failed to send exercise page", "error", err)
		return
	}

	// Delete the old message
	if _, err := b.api.Send(tgbotapi.NewDeleteMessage(cb.Message.Chat.ID, cb.Message.MessageID)); err != nil {
		slog.Error("send failed", "error", err)
	}
}

// handleSelectExerciseCallback adds the selected exercise to the session
func (b *Bot) handleSelectExerciseCallback(cb *tgbotapi.CallbackQuery, sessionID, exerciseID int64) {
	// Validation: Get and verify session
	session, err := b.workouts.GetWorkoutSession(sessionID)
	if err != nil || session == nil {
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Session not found.")); err != nil {
			slog.Error("send failed", "error", err)
		}
		return
	}

	// Validation: Verify session is still valid for adding exercises
	if session.Status != "in_progress" && session.Status != "completed" {
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ This workout is no longer active.")); err != nil {
			slog.Error("send failed", "error", err)
		}
		return
	}

	// Validation: Verify session belongs to the callback sender
	if session.UserID != cb.From.ID {
		slog.Warn("Security: Unauthorized access to add exercise", "userID", cb.From.ID, "sessionID", sessionID, "ownerID", session.UserID)
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Access denied.")); err != nil {
			slog.Error("send failed", "error", err)
		}
		return
	}

	// Get exercise details from the library (GetAllUniqueExercises returns library IDs when
	// the library is non-empty, so we must look up in exercise_library, not workout_exercises).
	libItem, err := b.workouts.GetExerciseLibraryItem(exerciseID)
	if err != nil || libItem == nil {
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Exercise not found.")); err != nil {
			slog.Error("send failed", "error", err)
		}
		return
	}
	// Wrap library item as a WorkoutExercise so downstream code stays the same
	exercise := &struct {
		ExerciseName   string
		TargetSets     int
		TargetRepsMin  int
		TargetRepsMax  *int
		TargetWeightKg *float64
	}{
		ExerciseName:   libItem.Name,
		TargetSets:     libItem.DefaultSets,
		TargetRepsMin:  libItem.DefaultRepsMin,
		TargetRepsMax:  libItem.DefaultRepsMax,
		TargetWeightKg: libItem.DefaultWeightKg,
	}

	// Validation: Verify the library item belongs to the session owner.
	if libItem.UserID != session.UserID {
		slog.Warn("Security: Unauthorized exercise access", "userID", session.UserID, "exerciseID", exerciseID, "libOwner", libItem.UserID)
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ This exercise is not available.")); err != nil {
			slog.Error("send failed", "error", err)
		}
		return
	}

	// All validations passed - delete the exercise list message
	if _, err := b.api.Send(tgbotapi.NewDeleteMessage(cb.Message.Chat.ID, cb.Message.MessageID)); err != nil {
		slog.Error("send failed", "error", err)
	}

	// Send exercise prompt for the selected exercise (use exerciseID as the exercise identifier)
	_, err = b.SendExercisePrompt(sessionID, exerciseID, exercise.ExerciseName,
		exercise.TargetSets, exercise.TargetRepsMin, exercise.TargetRepsMax, exercise.TargetWeightKg)
	if err != nil {
		slog.Error("Failed to send exercise prompt", "error", err)
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error adding exercise.")); err != nil {
			slog.Error("send failed", "error", err)
		}
	}
}

// handleCancelAddExerciseCallback deletes the exercise selection message without adding anything.
func (b *Bot) handleCancelAddExerciseCallback(cb *tgbotapi.CallbackQuery) {
	if _, err := b.api.Send(tgbotapi.NewDeleteMessage(cb.Message.Chat.ID, cb.Message.MessageID)); err != nil {
		slog.Error("send failed", "error", err)
	}
}
