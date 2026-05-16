package bot

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/korjavin/medicationtrackerbot/internal/store"
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

	// Compute total duration from exercises
	totalDurationSec := 0
	for _, ex := range parsedActivity.Exercises {
		if ex.DurationMinutes != nil {
			totalDurationSec += *ex.DurationMinutes * 60
		}
	}

	// Use time.Now() for ms-precision to avoid dedup collisions;
	// msg.Date has only second resolution so two rapid /activity calls
	// would collide on the (user_id, source_start_ms) unique index.
	startMs := time.Now().UnixMilli()
	endMs := startMs + int64(totalDurationSec)*1000

	workout := store.MiBandWorkout{
		UserID:        b.allowedUserID,
		SourceStartMs: startMs,
		SourceEndMs:   endMs,
		ActivityType:  0, // manual/unknown
		ActivityName:  parsedActivity.Name,
		DurationSec:   totalDurationSec,
		Source:        "manual",
	}

	imported, _, err := b.imports.ImportMiBand(ctx, []store.MiBandWorkout{workout}, nil)
	if err != nil {
		slog.Error("activity command: failed to save workout", "chat_id", msg.Chat.ID, "error", err)
		msgConfig.Text = "❌ Error saving activity."
		return
	}
	if imported == 0 {
		slog.Warn("activity command: workout was a duplicate (same start timestamp)", "chat_id", msg.Chat.ID)
		msgConfig.Text = "⚠️ Activity not saved: a duplicate entry with the same timestamp already exists."
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
