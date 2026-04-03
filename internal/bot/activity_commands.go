package bot

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

// handleActivityCommand handles the /activity command using natural language and the AI service.
// Example: /activity lazy swimming in aqua park
func (b *Bot) handleActivityCommand(msg *tgbotapi.Message, msgConfig *tgbotapi.MessageConfig) {
	if b.activityAI == nil {
		msgConfig.Text = "⚠️ AI activity logging is not configured. Missing OPENAI environment variables."
		return
	}

	args := msg.CommandArguments()
	if args == "" {
		msgConfig.Text = `*AI Activity Logging*

Usage: /activity <description>

Examples:
  /activity lazy swimming in aqua park
  /activity 5km morning run
  /activity bench press 3x10 at 80kg, pull-ups 3x8`
		msgConfig.ParseMode = "Markdown"
		return
	}

	// Tell the user we are processing
	processingMsg := tgbotapi.NewMessage(msg.Chat.ID, "⏳ Analyzing your activity...")
	sentMsg, err := b.api.Send(processingMsg)
	if err != nil {
		slog.Warn("activity command: failed to send processing message", "chat_id", msg.Chat.ID, "error", err)
	}

	defer func() {
		if sentMsg.MessageID != 0 {
			if _, err := b.api.Request(tgbotapi.NewDeleteMessage(msg.Chat.ID, sentMsg.MessageID)); err != nil {
				slog.Warn("activity command: failed to delete processing message", "chat_id", msg.Chat.ID, "message_id", sentMsg.MessageID, "error", err)
			}
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	parsedActivity, err := b.activityAI.ParseActivityDescription(ctx, args)
	if err != nil {
		slog.Error("activity command: analysis failed", "chat_id", msg.Chat.ID, "description", args, "error", err)
		msgConfig.Text = "❌ Failed to analyze activity: " + err.Error()
		return
	}

	now := time.Unix(int64(msg.Date), 0)

	// Create an ad-hoc workout session
	session, err := b.workoutSvc.CreateAdHocSession(b.allowedUserID, now, now.Format("15:04"))
	if err != nil {
		slog.Error("activity command: failed to create session", "chat_id", msg.Chat.ID, "error", err)
		msgConfig.Text = "❌ Error creating workout session."
		return
	}

	// Log each exercise
	for _, ex := range parsedActivity.Exercises {
		notes := ex.Notes
		if ex.DurationMinutes != nil {
			if notes != "" {
				notes = fmt.Sprintf("%d min; %s", *ex.DurationMinutes, notes)
			} else {
				notes = fmt.Sprintf("%d min", *ex.DurationMinutes)
			}
		}
		if _, err := b.activityLog.LogExercise(session.ID, -1, ex.Name, ex.Sets, ex.Reps, ex.WeightKg, "completed", notes); err != nil {
			slog.Error("activity command: failed to log exercise", "chat_id", msg.Chat.ID, "exercise", ex.Name, "error", err)
			msgConfig.Text = "❌ Error saving exercise log."
			return
		}
	}

	// Complete the session
	if err := b.workoutSvc.CompleteSession(session.ID); err != nil {
		slog.Error("activity command: failed to complete session", "chat_id", msg.Chat.ID, "session_id", session.ID, "error", err)
		msgConfig.Text = "❌ Error completing workout session."
		return
	}

	// Build summary
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("✅ Logged: *%s*\n\n", parsedActivity.Name))
	for _, ex := range parsedActivity.Exercises {
		sb.WriteString("• " + ex.Name)
		if ex.Sets != nil && ex.Reps != nil {
			sb.WriteString(fmt.Sprintf(" — %d×%d", *ex.Sets, *ex.Reps))
			if ex.WeightKg != nil {
				sb.WriteString(fmt.Sprintf(" @ %.1fkg", *ex.WeightKg))
			}
		} else if ex.DurationMinutes != nil {
			sb.WriteString(fmt.Sprintf(" — %d min", *ex.DurationMinutes))
		}
		if ex.Notes != "" {
			sb.WriteString(fmt.Sprintf(" (%s)", ex.Notes))
		}
		sb.WriteString("\n")
	}

	msgConfig.Text = sb.String()
	msgConfig.ParseMode = "Markdown"
}
