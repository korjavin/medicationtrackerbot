package bot

import (
	"fmt"
	"log/slog"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

// handleAdHocWorkoutCommand starts an ad-hoc (unscheduled) workout
func (b *Bot) handleAdHocWorkoutCommand(msgConfig *tgbotapi.MessageConfig) {
	// Create ad-hoc workout session
	now := time.Now().In(b.userLocation())
	scheduledTime := now.Format("15:04")

	session, err := b.workoutSvc.CreateAdHocSession(b.allowedUserID, now, scheduledTime)
	if err != nil {
		slog.Error("Error creating ad-hoc workout session", "error", err)
		msgConfig.Text = "❌ Error creating ad-hoc workout session."
		return
	}

	// Send confirmation message
	msgConfig.Text = fmt.Sprintf("💪 **Ad-hoc Workout Started!**\n\nSession #%d is in progress.\n\nSelect an exercise to add:", session.ID)
	msgConfig.ParseMode = "Markdown"

	// After the bot sends msgConfig, we need to send the exercise list
	// We'll do this by sending it directly here (after the msgConfig is sent by the caller)
	go func() {
		// Small delay to ensure the confirmation message is sent first
		time.Sleep(100 * time.Millisecond)

		// Use existing SendExerciseList method
		_, err := b.SendExerciseList(session.ID, b.allowedUserID)
		if err != nil {
			slog.Error("Failed to send exercise list for ad-hoc workout", "error", err)
			// Send fallback message
			msg := tgbotapi.NewMessage(b.allowedUserID, "⚠️ Exercise list unavailable. Use the web app to add exercises.")
			if _, err := b.api.Send(msg); err != nil {
				slog.Error("send failed", "error", err)
			}
		}
	}()
}
