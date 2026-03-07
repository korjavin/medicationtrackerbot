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
	} else if strings.HasPrefix(data, "workout_finish_") {
		action = "finish"
		sessionIDStr = data[15:]
	}

	sessionID, err := strconv.ParseInt(sessionIDStr, 10, 64)
	if err != nil {
		log.Printf("Invalid session ID: %v", err)
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Invalid callback data.")); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}
		return
	}

	session, err := b.workouts.GetWorkoutSession(sessionID)
	if err != nil || session == nil {
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Workout session not found.")); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}
		return
	}

	// Verify the user owns this session
	if session.UserID != cb.From.ID {
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Unauthorized: this session belongs to another user.")); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}
		return
	}

	switch action {
	case "start":
		// Mark session as in_progress and clear any snooze
		if err := b.workoutSvc.StartSession(sessionID); err != nil {
			log.Printf("Failed to start session: %v", err)
			if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error starting workout.")); err != nil {
				log.Printf("[bot] send failed: %v", err)
			}
			return
		}

		// Remove buttons from notification
		edit := tgbotapi.NewEditMessageReplyMarkup(cb.Message.Chat.ID, cb.Message.MessageID, tgbotapi.InlineKeyboardMarkup{
			InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{},
		})
		if _, err := b.api.Send(edit); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}
		b.trackWorkoutMessage(sessionID, cb.Message.MessageID)

		// Start exercise-by-exercise prompts
		b.startExerciseLoop(sessionID, session.VariantID, cb.Message.Chat.ID)

	case "snooze1":
		if err := b.workoutSvc.SnoozeSession(sessionID, 1*time.Hour); err != nil {
			log.Printf("Failed to snooze session: %v", err)
			if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error snoozing workout.")); err != nil {
				log.Printf("[bot] send failed: %v", err)
			}
			return
		}
		// Delete notification
		if _, err := b.api.Send(tgbotapi.NewDeleteMessage(cb.Message.Chat.ID, cb.Message.MessageID)); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}

	case "snooze2":
		if err := b.workoutSvc.SnoozeSession(sessionID, 2*time.Hour); err != nil {
			log.Printf("Failed to snooze session: %v", err)
			if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error snoozing workout.")); err != nil {
				log.Printf("[bot] send failed: %v", err)
			}
			return
		}
		// Delete notification
		if _, err := b.api.Send(tgbotapi.NewDeleteMessage(cb.Message.Chat.ID, cb.Message.MessageID)); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}

	case "skip":
		// Service handles skip + rotation advancement for rotating groups
		if err := b.workoutSvc.SkipSession(sessionID); err != nil {
			log.Printf("Failed to skip session: %v", err)
			if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error skipping workout.")); err != nil {
				log.Printf("[bot] send failed: %v", err)
			}
			return
		}
		// Delete notification
		if _, err := b.api.Send(tgbotapi.NewDeleteMessage(cb.Message.Chat.ID, cb.Message.MessageID)); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}
		if err := b.CleanupWorkoutSessionMessages(sessionID); err != nil {
			log.Printf("Failed to cleanup workout messages: %v", err)
		}

	case "finish":
		// User explicitly finished the workout; service handles complete + rotation advancement
		if session.Status != "completed" {
			if err := b.workoutSvc.CompleteSession(sessionID); err != nil {
				log.Printf("Failed to complete session: %v", err)
				if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error saving workout.")); err != nil {
					log.Printf("[bot] send failed: %v", err)
				}
				return
			}
		}

		// Remove buttons
		edit := tgbotapi.NewEditMessageReplyMarkup(cb.Message.Chat.ID, cb.Message.MessageID, tgbotapi.InlineKeyboardMarkup{
			InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{},
		})
		if _, err := b.api.Send(edit); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}

		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "👍 Workout saved.")); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}
		if err := b.CleanupWorkoutSessionMessages(sessionID); err != nil {
			log.Printf("Failed to cleanup workout messages: %v", err)
		}
	}
}

// startExerciseLoop sends exercise prompts one by one
func (b *Bot) startExerciseLoop(sessionID, variantID int64, chatID int64) {
	exercises, err := b.workouts.ListExercisesByVariant(variantID)
	if err != nil || len(exercises) == 0 {
		if _, err := b.api.Send(tgbotapi.NewMessage(chatID, "❌ No exercises found for this workout.")); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}
		return
	}

	startMsg, err := b.api.Send(tgbotapi.NewMessage(chatID, fmt.Sprintf("🏋️ **Workout Started**\n\n%d exercises to complete:", len(exercises))))
	if err != nil {
		log.Printf("[bot] send failed: %v", err)
	} else {
		b.trackWorkoutMessage(sessionID, startMsg.MessageID)
	}

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
	sessionID, err := strconv.ParseInt(parts[2], 10, 64)
	if err != nil {
		log.Printf("[bot] Failed to parse session ID from callback data: %v", err)
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Invalid callback data.")); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}
		return
	}
	exerciseID, err := strconv.ParseInt(parts[3], 10, 64)
	if err != nil {
		log.Printf("[bot] Failed to parse exercise ID from callback data: %v", err)
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Invalid callback data.")); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}
		return
	}

	// Verify the user owns this session
	session, err := b.workouts.GetWorkoutSession(sessionID)
	if err != nil || session == nil || session.UserID != cb.From.ID {
		log.Printf("[bot] Session %d not found or unauthorized for user %d", sessionID, cb.From.ID)
		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Unauthorized: this session belongs to another user.")); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}
		return
	}

	switch action {
	case "done":
		if err := b.exerciseSvc.LogExercise(sessionID, exerciseID, "completed"); err != nil {
			log.Printf("Failed to log exercise: %v", err)
			if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error logging exercise.")); err != nil {
				log.Printf("[bot] send failed: %v", err)
			}
			return
		}

		editText := tgbotapi.NewEditMessageText(cb.Message.Chat.ID, cb.Message.MessageID,
			cb.Message.Text+"\n\n✅ Completed")
		editText.ParseMode = "Markdown"
		if _, err := b.api.Send(editText); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}

		edit := tgbotapi.NewEditMessageReplyMarkup(cb.Message.Chat.ID, cb.Message.MessageID, tgbotapi.InlineKeyboardMarkup{
			InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{},
		})
		if _, err := b.api.Send(edit); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}

		b.checkWorkoutCompletion(sessionID, cb.Message.Chat.ID)

	case "skip":
		if err := b.exerciseSvc.LogExercise(sessionID, exerciseID, "skipped"); err != nil {
			log.Printf("Failed to log skipped exercise: %v", err)
			if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error logging exercise.")); err != nil {
				log.Printf("[bot] send failed: %v", err)
			}
			return
		}

		editText := tgbotapi.NewEditMessageText(cb.Message.Chat.ID, cb.Message.MessageID,
			cb.Message.Text+"\n\n⏭ Skipped")
		editText.ParseMode = "Markdown"
		if _, err := b.api.Send(editText); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}

		edit := tgbotapi.NewEditMessageReplyMarkup(cb.Message.Chat.ID, cb.Message.MessageID, tgbotapi.InlineKeyboardMarkup{
			InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{},
		})
		if _, err := b.api.Send(edit); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}

		b.checkWorkoutCompletion(sessionID, cb.Message.Chat.ID)

	case "edit":
		if err := b.exerciseSvc.LogExercise(sessionID, exerciseID, "completed"); err != nil {
			log.Printf("Failed to log exercise (edit): %v", err)
			if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID, "❌ Error logging exercise.")); err != nil {
				log.Printf("[bot] send failed: %v", err)
			}
			return
		}

		if _, err := b.api.Send(tgbotapi.NewMessage(cb.Message.Chat.ID,
			"To edit, please use the web interface for now. Click 'Menu' to open the app.")); err != nil {
			log.Printf("Failed to send edit message: %v", err)
		}

		editText := tgbotapi.NewEditMessageText(cb.Message.Chat.ID, cb.Message.MessageID,
			cb.Message.Text+"\n\n✅ Logged (edit in web app)")
		editText.ParseMode = "Markdown"
		if _, err := b.api.Send(editText); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}

		edit := tgbotapi.NewEditMessageReplyMarkup(cb.Message.Chat.ID, cb.Message.MessageID, tgbotapi.InlineKeyboardMarkup{
			InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{},
		})
		if _, err := b.api.Send(edit); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}

		b.checkWorkoutCompletion(sessionID, cb.Message.Chat.ID)
	}
}

// checkWorkoutCompletion checks if all exercises are done and prompts the user to finish.
func (b *Bot) checkWorkoutCompletion(sessionID int64, chatID int64) {
	session, err := b.workouts.GetWorkoutSession(sessionID)
	if err != nil || session == nil {
		return
	}

	done, completedCount, totalCount, err := b.exerciseSvc.CheckSessionCompletion(sessionID, session.VariantID)
	if err != nil {
		log.Printf("[bot] checkWorkoutCompletion: %v", err)
		return
	}

	if done && totalCount > 0 {
		if err := b.SendWorkoutComplete(chatID, sessionID, completedCount, totalCount); err != nil {
			log.Printf("[bot] send failed: %v", err)
		}
	}
}
