package scheduler

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
)

// checkWeightReminders checks if any users need weight reminder notifications
func (s *Scheduler) checkWeightReminders() error {
	enabled, err := s.weightReminders.GetWeightEnabled(context.Background())
	if err != nil {
		return err
	}
	if !enabled {
		return nil
	}

	// Get all users with weight reminders enabled
	userIDs, err := s.weightReminders.GetUsersForWeightReminders()
	if err != nil {
		return err
	}

	ctx := context.Background()
	now := time.Now()

	for _, userID := range userIDs {
		// Get reminder state
		state, err := s.weightReminders.GetWeightReminderState(userID)
		if err != nil {
			log.Printf("Error getting weight reminder state for user %d: %v", userID, err)
			continue
		}

		// Filter 1: Check if reminders are enabled
		if !state.Enabled {
			continue
		}

		// Filter 2: Check if snoozed
		if state.SnoozedUntil != nil && now.Before(*state.SnoozedUntil) {
			continue
		}

		// Filter 3: Check if "don't bug me" is active
		if state.DontRemindUntil != nil && now.Before(*state.DontRemindUntil) {
			continue
		}

		// Get last weight log
		lastLog, err := s.weightReminders.GetLastWeightLog(ctx, userID)
		if err != nil {
			log.Printf("Error getting last weight log for user %d: %v", userID, err)
			continue
		}

		// Filter 4: Check if already measured in last 7 days
		if lastLog != nil && time.Since(lastLog.MeasuredAt) < 7*24*time.Hour {
			continue
		}

		// Filter 5: Check minimum 5-day gap (prevents spam if user deletes entry)
		if lastLog != nil && time.Since(lastLog.MeasuredAt) < 5*24*time.Hour {
			continue
		}

		// Filter 6: Calculate preferred reminder hour dynamically
		preferredHour, err := s.weightReminders.CalculatePreferredWeightReminderHour(ctx, userID)
		if err != nil {
			log.Printf("Error calculating preferred hour for user %d: %v", userID, err)
			preferredHour = 9 // Fallback to default
		}

		// Update if different from stored value
		if preferredHour != state.PreferredReminderHour {
			if err := s.weightReminders.UpdatePreferredWeightReminderHour(userID, preferredHour); err != nil {
				log.Printf("Error updating preferred hour for user %d: %v", userID, err)
			}
		}

		// Filter 7: Check if current time is within ±2 hours of preferred time (wider window than BP)
		currentHour := now.Hour()
		if currentHour < preferredHour-2 || currentHour > preferredHour+2 {
			continue
		}

		// Filter 8: Check if we already sent a notification in last 7 days (rate limiting)
		if state.LastNotificationSentAt != nil {
			if time.Since(*state.LastNotificationSentAt) < 7*24*time.Hour {
				continue
			}
		}

		// Send reminder notification
		if err := s.sendWeightReminder(ctx, userID); err != nil {
			log.Printf("Error sending weight reminder to user %d: %v", userID, err)
			continue
		}

		log.Printf("Sent weight reminder to user %d", userID)
	}

	return nil
}

// sendWeightReminder sends a weight reminder notification via all notifiers
func (s *Scheduler) sendWeightReminder(ctx context.Context, userID int64) error {
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

	for _, nr := range s.notifiers {
		msgID, err := nr.Send(ctx, userID, n)
		if err != nil {
			log.Printf("Failed to send weight reminder via %T: %v", nr, err)
			continue
		}
		anySuccess = true
		if msgID != 0 && firstMsgID == 0 {
			firstMsgID = msgID
		}
	}

	// CRITICAL: Only update if at least one channel succeeded
	if !anySuccess {
		return fmt.Errorf("failed to send weight reminder via any channel")
	}

	// Update state with successful delivery
	var messageID *int
	if firstMsgID != 0 {
		messageID = &firstMsgID
	}
	return s.weightReminders.UpdateWeightReminderNotificationSent(userID, messageID)
}
