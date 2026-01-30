package bot

import (
	"fmt"
	"log"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

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

	log.Printf("Sent workout notification (session %d): %s", sessionID, text)
	return sentMsg.MessageID, nil
}

// SendExercisePrompt sends a prompt for a specific exercise during workout
func (b *Bot) SendExercisePrompt(sessionID int64, exerciseID int64, exerciseName string, sets, repsMin int, repsMax *int, weightKg *float64) (int, error) {
	repsStr := fmt.Sprintf("%d", repsMin)
	if repsMax != nil && *repsMax != repsMin {
		repsStr = fmt.Sprintf("%d-%d", repsMin, *repsMax)
	}

	text := fmt.Sprintf("**%s**\n%d sets × %s reps", exerciseName, sets, repsStr)
	if weightKg != nil {
		text += fmt.Sprintf(" @ %.0fkg", *weightKg)
	}

	// Create inline keyboard for exercise actions
	keyboard := tgbotapi.NewInlineKeyboardMarkup(
		tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData("✅ Done", fmt.Sprintf("exercise_done_%d_%d", sessionID, exerciseID)),
		),
		tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData("⏭ Skip Exercise", fmt.Sprintf("exercise_skip_%d_%d", sessionID, exerciseID)),
		),
	)

	msg := tgbotapi.NewMessage(b.allowedUserID, text)
	msg.ParseMode = "Markdown"
	msg.ReplyMarkup = keyboard

	sentMsg, err := b.api.Send(msg)
	if err != nil {
		return 0, fmt.Errorf("failed to send exercise prompt: %w", err)
	}

	return sentMsg.MessageID, nil
}

// SendWorkoutComplete sends a completion message
func (b *Bot) SendWorkoutComplete(sessionID int64, completedExercises, totalExercises int) error {
	text := fmt.Sprintf("✅ **Workout Complete!**\n\nCompleted %d/%d exercises", completedExercises, totalExercises)

	msg := tgbotapi.NewMessage(b.allowedUserID, text)
	msg.ParseMode = "Markdown"

	_, err := b.api.Send(msg)
	return err
}
