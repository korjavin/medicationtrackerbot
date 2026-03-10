package scheduler

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// WeightReminderStore is the subset needed for weight reminders.
type WeightReminderStore interface {
	GetWeightEnabled(ctx context.Context) (bool, error)
	GetUsersForWeightReminders() ([]int64, error)
	GetWeightReminderState(userID int64) (*store.WeightReminderState, error)
	GetLastWeightLog(ctx context.Context, userID int64) (*store.WeightLog, error)
	CalculatePreferredWeightReminderHour(ctx context.Context, userID int64) (int, error)
	UpdatePreferredWeightReminderHour(userID int64, hour int) error
	UpdateWeightReminderNotificationSent(userID int64, messageID *int) error
}

// WeightReminderChecker checks if any users need weight reminder notifications.
type WeightReminderChecker struct {
	store     WeightReminderStore
	notifiers []notifier.Notifier
	now       func() time.Time
}

func (c *WeightReminderChecker) Check(ctx context.Context) error {
	enabled, err := c.store.GetWeightEnabled(ctx)
	if err != nil {
		return err
	}
	if !enabled {
		return nil
	}

	userIDs, err := c.store.GetUsersForWeightReminders()
	if err != nil {
		return err
	}

	if c.now == nil {
		c.now = time.Now
	}
	now := c.now()

	for _, userID := range userIDs {
		state, err := c.store.GetWeightReminderState(userID)
		if err != nil {
			slog.Error("Error getting weight reminder state", "userID", userID, "error", err)
			continue
		}

		if !state.Enabled {
			continue
		}

		if state.SnoozedUntil != nil && now.Before(*state.SnoozedUntil) {
			continue
		}

		if state.DontRemindUntil != nil && now.Before(*state.DontRemindUntil) {
			continue
		}

		lastLog, err := c.store.GetLastWeightLog(ctx, userID)
		if err != nil {
			slog.Error("Error getting last weight log", "userID", userID, "error", err)
			continue
		}

		if lastLog != nil && now.Sub(lastLog.MeasuredAt) < 7*24*time.Hour {
			continue
		}

		if lastLog != nil && now.Sub(lastLog.MeasuredAt) < 5*24*time.Hour {
			continue
		}

		preferredHour := state.PreferredReminderHour
		if preferredHour == 0 {
			preferredHour, err = c.store.CalculatePreferredWeightReminderHour(ctx, userID)
			if err != nil {
				slog.Warn("Error calculating preferred hour", "userID", userID, "error", err)
				preferredHour = 9
			}

			if preferredHour != state.PreferredReminderHour {
				if err := c.store.UpdatePreferredWeightReminderHour(userID, preferredHour); err != nil {
					slog.Error("Error updating preferred hour", "userID", userID, "error", err)
				}
			}
		}

		currentHour := now.Hour()
		if currentHour < preferredHour-2 || currentHour > preferredHour+2 {
			continue
		}

		if state.LastNotificationSentAt != nil {
			if now.Sub(*state.LastNotificationSentAt) < 7*24*time.Hour {
				continue
			}
		}

		if err := c.sendWeightReminder(ctx, userID); err != nil {
			slog.Error("Error sending weight reminder", "userID", userID, "error", err)
			continue
		}

		slog.Info("Sent weight reminder", "userID", userID)
	}

	return nil
}

// sendWeightReminder sends a weight reminder notification via all notifiers synchronously.
func (c *WeightReminderChecker) sendWeightReminder(ctx context.Context, userID int64) error {
	text := "⚖️ **Time to track your weight**\n\n"
	text += "It's been about a week since your last measurement. "
	text += "Regular tracking helps you stay on top of your goals!"

	n := notifier.Notification{
		Text: text,
		Actions: []notifier.Action{
			{ID: "weight_confirm", Label: "✅ Confirm"},
			{ID: "weight_snooze", Label: "⏰ Snooze (2h)"},
			{ID: "weight_dontbug", Label: "🔇 Don't Bug Me (24h)"},
		},
		Tag: "weight-reminder",
		Metadata: map[string]interface{}{
			"type": "weight_reminder",
		},
	}

	anySuccess := false
	var firstMsgID int

	for _, nr := range c.notifiers {
		msgID, err := nr.Send(ctx, userID, n)
		if err != nil {
			slog.Error("Failed to send weight reminder", "notifier", nr, "error", err)
			continue
		}
		anySuccess = true
		if msgID != 0 && firstMsgID == 0 {
			firstMsgID = msgID
		}
	}

	if !anySuccess {
		return fmt.Errorf("failed to send weight reminder via any channel")
	}

	var messageID *int
	if firstMsgID != 0 {
		messageID = &firstMsgID
	}
	return c.store.UpdateWeightReminderNotificationSent(userID, messageID)
}
