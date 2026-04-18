package scheduler

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// BPReminderStore is the subset needed for blood pressure reminders.
type BPReminderStore interface {
	GetBloodPressureEnabled(ctx context.Context) (bool, error)
	GetUsersForBPReminders() ([]int64, error)
	GetBPReminderState(userID int64) (*store.BPReminderState, error)
	GetLastBPReading(ctx context.Context, userID int64) (*store.BloodPressure, error)
	CalculatePreferredReminderHour(ctx context.Context, userID int64) (int, error)
	UpdatePreferredReminderHour(userID int64, hour int) error
	GetDominantBPCategory(ctx context.Context, userID int64) (string, error)
	UpdateBPReminderNotificationSent(userID int64, messageID *int) error
	GetCurrentTimezone() (string, error)

	// Batch methods
	BatchGetBPReminderStates(userIDs []int64) (map[int64]*store.BPReminderState, error)
	BatchGetLastBPReadings(ctx context.Context, userIDs []int64) (map[int64]*store.BloodPressure, error)
	BatchGetDominantBPCategories(ctx context.Context, userIDs []int64) (map[int64]string, error)
	BatchCalculatePreferredReminderHours(ctx context.Context, userIDs []int64) (map[int64]int, error)
}

// BPReminderChecker checks if any users need BP reminder notifications.
type BPReminderChecker struct {
	store     BPReminderStore
	notifiers []notifier.Notifier
	now       func() time.Time // injectable clock; defaults to time.Now
}

func (c *BPReminderChecker) Check(ctx context.Context) error {
	enabled, err := c.store.GetBloodPressureEnabled(ctx)
	if err != nil {
		return err
	}
	if !enabled {
		return nil
	}

	userIDs, err := c.store.GetUsersForBPReminders()
	if err != nil {
		return err
	}
	if len(userIDs) == 0 {
		return nil
	}

	// Load user timezone. Only apply if explicitly set — leave time as-is otherwise.
	var userLoc *time.Location
	if tz, err := c.store.GetCurrentTimezone(); err != nil {
		slog.Warn("Failed to get user timezone, falling back to system TZ", "error", err)
	} else if tz != "" {
		if loc, err := time.LoadLocation(tz); err != nil {
			slog.Warn("Invalid user timezone, falling back to system TZ", "tz", tz, "error", err)
		} else {
			userLoc = loc
		}
	}

	if c.now == nil {
		c.now = time.Now
	}
	now := c.now()
	if userLoc != nil {
		now = now.In(userLoc)
	}
	todayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())

	states, err := c.store.BatchGetBPReminderStates(userIDs)
	if err != nil {
		slog.Error("Error batch getting BP reminder states", "error", err)
		return err
	}

	lastReadings, err := c.store.BatchGetLastBPReadings(ctx, userIDs)
	if err != nil {
		slog.Error("Error batch getting last BP readings", "error", err)
		return err
	}

	var usersToCalculateHour []int64
	var usersToNotify []int64

	// Pass 1: Filter users and find those needing hour recalculation
	for _, userID := range userIDs {
		state, ok := states[userID]
		if !ok {
			// Should be created by Batch method if missing, but fallback just in case
			state, err = c.store.GetBPReminderState(userID)
			if err != nil || state == nil {
				slog.Error("Error getting fallback BP reminder state", "userID", userID, "error", err)
				continue
			}
			states[userID] = state
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

		lastReading := lastReadings[userID]
		if lastReading != nil && lastReading.MeasuredAt.After(todayStart) {
			continue
		}

		if lastReading != nil && now.Sub(lastReading.MeasuredAt) < 12*time.Hour {
			continue
		}

		if state.PreferredReminderHour == 0 {
			usersToCalculateHour = append(usersToCalculateHour, userID)
		} else {
			currentHour := now.Hour()
			if currentHour >= state.PreferredReminderHour-1 && currentHour <= state.PreferredReminderHour+1 {
				// Eligible for notification
				usersToNotify = append(usersToNotify, userID)
			}
		}
	}

	// Calculate preferred hours in batch
	if len(usersToCalculateHour) > 0 {
		calculatedHours, err := c.store.BatchCalculatePreferredReminderHours(ctx, usersToCalculateHour)
		if err != nil {
			slog.Warn("Error batch calculating preferred hours", "error", err)
		} else {
			for _, userID := range usersToCalculateHour {
				hour, ok := calculatedHours[userID]
				if !ok {
					hour = 20
				}

				state := states[userID]
				if hour != state.PreferredReminderHour {
					if err := c.store.UpdatePreferredReminderHour(userID, hour); err != nil {
						slog.Error("Error updating preferred hour", "userID", userID, "error", err)
					}
					state.PreferredReminderHour = hour
				}

				currentHour := now.Hour()
				if currentHour >= state.PreferredReminderHour-1 && currentHour <= state.PreferredReminderHour+1 {
					usersToNotify = append(usersToNotify, userID)
				}
			}
		}
	}

	if len(usersToNotify) == 0 {
		return nil
	}

	// Double check notification day restrictions before batching dominants
	var finalUsersToNotify []int64
	for _, userID := range usersToNotify {
		state := states[userID]
		if state.LastNotificationSentAt != nil {
			lastSentLocal := state.LastNotificationSentAt.In(now.Location())
			lastSentDay := time.Date(lastSentLocal.Year(), lastSentLocal.Month(), lastSentLocal.Day(), 0, 0, 0, 0, now.Location())
			if !lastSentDay.Before(todayStart) {
				continue
			}
		}
		finalUsersToNotify = append(finalUsersToNotify, userID)
	}

	if len(finalUsersToNotify) == 0 {
		return nil
	}

	// Batch calculate dominants for the users we are going to notify
	dominants, err := c.store.BatchGetDominantBPCategories(ctx, finalUsersToNotify)
	if err != nil {
		slog.Warn("Error batch getting dominant BP categories", "error", err)
	}

	// Pass 2: Notify
	for _, userID := range finalUsersToNotify {
		lastReading := lastReadings[userID]

		shouldSendEnhanced := false
		if dominants != nil {
			dominantCategory, ok := dominants[userID]
			if ok && lastReading != nil {
				lastSeverity := store.CategorySeverity(lastReading.Category)
				dominantSeverity := store.CategorySeverity(dominantCategory)

				if lastSeverity > dominantSeverity {
					shouldSendEnhanced = true
				}
			}
		}

		if err := c.sendBPReminder(ctx, userID, shouldSendEnhanced); err != nil {
			slog.Error("Error sending BP reminder", "userID", userID, "error", err)
			continue
		}

		slog.Info("Sent BP reminder", "userID", userID, "enhanced", shouldSendEnhanced)
	}

	return nil
}

// sendBPReminder sends a BP reminder notification via all notifiers synchronously.
func (c *BPReminderChecker) sendBPReminder(ctx context.Context, userID int64, enhanced bool) error {
	text := "📊 **Time to measure your blood pressure**\n\n"
	if enhanced {
		text += "⚠️ Your recent readings have been higher than usual. Regular monitoring is important.\n\n"
	}
	text += "Please take a moment to measure and record your BP."

	n := notifier.Notification{
		Text: text,
		Actions: []notifier.Action{
			{ID: "bp_confirm", Label: "✅ Confirm"},
			{ID: "bp_snooze", Label: "⏰ Snooze (2h)"},
			{ID: "bp_dontbug", Label: "🔇 Don't Bug Me (24h)"},
		},
		Tag: "bp-reminder",
		Metadata: map[string]interface{}{
			"type":     "bp_reminder",
			"enhanced": enhanced,
		},
	}

	anySuccess := false
	var firstMsgID int

	for _, nr := range c.notifiers {
		msgID, err := nr.Send(ctx, userID, n)
		if err != nil {
			slog.Error("Failed to send BP reminder", "notifier", nr, "error", err)
			continue
		}
		anySuccess = true
		if msgID != 0 && firstMsgID == 0 {
			firstMsgID = msgID
		}
	}

	if !anySuccess {
		return fmt.Errorf("failed to send BP reminder via any channel")
	}

	var messageID *int
	if firstMsgID != 0 {
		messageID = &firstMsgID
	}
	return c.store.UpdateBPReminderNotificationSent(userID, messageID)
}
