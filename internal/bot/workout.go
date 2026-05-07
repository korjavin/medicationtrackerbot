package bot

import (
	"fmt"
	"log/slog"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

// StartWorkoutFlowFromWeb mirrors Telegram "Start" callback behavior when workout is started from web UI.
// It sends a confirmation message and exercise prompts with inline action buttons.
func (b *Bot) StartWorkoutFlowFromWeb(sessionID int64) error {
	session, err := b.workouts.GetWorkoutSession(sessionID)
	if err != nil {
		return fmt.Errorf("failed to get workout session: %w", err)
	}
	if session == nil {
		return fmt.Errorf("workout session not found: %d", sessionID)
	}

	// Ad-hoc sessions (group_id = -1) have no variant and no workout_exercises
	// rows — only placeholder workout_exercise_logs. The variant-driven prompt
	// loop has nothing to send, so route to the same confirmation surface that
	// the bot's own start callback uses.
	if session.GroupID == -1 {
		b.sendAdHocStartConfirmation(sessionID, b.allowedUserID)
		return nil
	}

	b.startExerciseLoop(sessionID, session.VariantID, b.allowedUserID)
	return nil
}

// SendWorkoutNotification sends a workout notification with inline buttons
func (b *Bot) SendWorkoutNotification(text string, sessionID int64) (int, error) {
	// Create inline keyboard with workout action buttons
	keyboard := tgbotapi.NewInlineKeyboardMarkup(
		tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData("▶️ Start Now", fmt.Sprintf("workout_start_%d", sessionID)),
		),
		tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData("⏰ Snooze 1h", fmt.Sprintf("workout_snooze1_%d", sessionID)),
			tgbotapi.NewInlineKeyboardButtonData("⏰ Snooze 2h", fmt.Sprintf("workout_snooze2_%d", sessionID)),
		),
		tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData("⏭ Skip", fmt.Sprintf("workout_skip_%d", sessionID)),
		),
	)

	msg := tgbotapi.NewMessage(b.allowedUserID, text)
	msg.ParseMode = "Markdown"
	msg.ReplyMarkup = keyboard

	sentMsg, err := b.api.Send(msg)
	if err != nil {
		return 0, fmt.Errorf("failed to send workout notification: %w", err)
	}
	b.trackWorkoutMessage(sessionID, sentMsg.MessageID)

	slog.Info("Sent workout notification", "sessionID", sessionID, "text", text)
	return sentMsg.MessageID, nil
}

// SendExercisePrompt sends a prompt for a specific exercise during workout
func (b *Bot) SendExercisePrompt(sessionID int64, exerciseID int64, exerciseName string, sets, repsMin int, repsMax *int, weightKg *float64) (int, error) {
	return b.sendExercisePromptWithSource(sessionID, exerciseID, exerciseName, sets, repsMin, repsMax, weightKg, false)
}

// SendExercisePromptFromLibrary sends an exercise prompt for a library-sourced exercise.
// The callback data encodes the library origin so LogExercise skips workout_exercises lookup.
func (b *Bot) SendExercisePromptFromLibrary(sessionID int64, exerciseID int64, exerciseName string, sets, repsMin int, repsMax *int, weightKg *float64) (int, error) {
	return b.sendExercisePromptWithSource(sessionID, exerciseID, exerciseName, sets, repsMin, repsMax, weightKg, true)
}

func (b *Bot) sendExercisePromptWithSource(sessionID int64, exerciseID int64, exerciseName string, sets, repsMin int, repsMax *int, weightKg *float64, fromLibrary bool) (int, error) {
	repsStr := fmt.Sprintf("%d", repsMin)
	if repsMax != nil && *repsMax != repsMin {
		repsStr = fmt.Sprintf("%d-%d", repsMin, *repsMax)
	}

	text := fmt.Sprintf("**%s**\n%d sets × %s reps", exerciseName, sets, repsStr)
	if weightKg != nil {
		text += fmt.Sprintf(" @ %.0fkg", *weightKg)
	}

	// Encode exercise source in callback data: "L" prefix for library IDs to prevent
	// cross-table ID collisions between exercise_library and workout_exercises.
	idStr := fmt.Sprintf("%d", exerciseID)
	if fromLibrary {
		idStr = fmt.Sprintf("L%d", exerciseID)
	}

	// Create inline keyboard for exercise actions
	keyboard := tgbotapi.NewInlineKeyboardMarkup(
		tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData("✅ Done", fmt.Sprintf("exercise_done_%d_%s", sessionID, idStr)),
		),
		tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData("⏭ Skip Exercise", fmt.Sprintf("exercise_skip_%d_%s", sessionID, idStr)),
		),
	)

	msg := tgbotapi.NewMessage(b.allowedUserID, text)
	msg.ParseMode = "Markdown"
	msg.ReplyMarkup = keyboard

	sentMsg, err := b.api.Send(msg)
	if err != nil {
		return 0, fmt.Errorf("failed to send exercise prompt: %w", err)
	}
	b.trackWorkoutMessage(sessionID, sentMsg.MessageID)

	return sentMsg.MessageID, nil
}

// SendWorkoutComplete sends a completion message
func (b *Bot) SendWorkoutComplete(chatID, sessionID int64, completedExercises, totalExercises int) error {
	text := fmt.Sprintf("✅ **Planned exercises done**\n\nCompleted %d/%d exercises", completedExercises, totalExercises)

	// Add "Add Exercise" button
	keyboard := tgbotapi.NewInlineKeyboardMarkup(
		tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData("➕ Add Exercise", fmt.Sprintf("add_exercise_%d", sessionID)),
			tgbotapi.NewInlineKeyboardButtonData("🏁 Finish Workout", fmt.Sprintf("workout_finish_%d", sessionID)),
		),
	)

	msg := tgbotapi.NewMessage(chatID, text)
	msg.ParseMode = "Markdown"
	msg.ReplyMarkup = keyboard

	sentMsg, err := b.api.Send(msg)
	if err != nil {
		return err
	}
	// Track completion cards too, so web-side completion can clean them up.
	b.trackWorkoutMessage(sessionID, sentMsg.MessageID)
	return nil
}
