package scheduler

import (
	"context"
	"fmt"
	"log"
	"time"
)

// checkWeightReminders checks if any users need weight reminder notifications
func (s *Scheduler) checkWeightReminders() error {
	// Get all users with weight reminders enabled
	userIDs, err := s.store.GetUsersForWeightReminders()
	if err != nil {
		return err
	}

	ctx := context.Background()
	now := time.Now()

	for _, userID := range userIDs {
		// Get reminder state
		state, err := s.store.GetWeightReminderState(userID)
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
		lastLog, err := s.store.GetLastWeightLog(ctx, userID)
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
		preferredHour, err := s.store.CalculatePreferredWeightReminderHour(ctx, userID)
		if err != nil {
			log.Printf("Error calculating preferred hour for user %d: %v", userID, err)
			preferredHour = 9 // Fallback to default
		}

		// Update if different from stored value
		if preferredHour != state.PreferredReminderHour {
			if err := s.store.UpdatePreferredWeightReminderHour(userID, preferredHour); err != nil {
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

// sendWeightReminder sends a weight reminder notification via Telegram and Web Push
// P2 FIX: Only update state if delivery succeeds
func (s *Scheduler) sendWeightReminder(ctx context.Context, userID int64) error {
	var messageID *int
	telegramSuccess := false
	webPushSuccess := false

	// Send Telegram notification
	if s.bot != nil {
		msgID, err := s.bot.SendWeightReminderNotification(userID)
		if err != nil {
			log.Printf("Failed to send Telegram weight reminder: %v", err)
		} else {
			messageID = &msgID
			telegramSuccess = true
		}
	}

	// Send Web Push notification
	if s.webPush != nil {
		if err := s.webPush.SendWeightReminderNotification(ctx, userID); err != nil {
			log.Printf("Failed to send Web Push weight reminder: %v", err)
		} else {
			webPushSuccess = true
		}
	}

	// CRITICAL: Only update if at least one channel succeeded
	if !telegramSuccess && !webPushSuccess {
		return fmt.Errorf("failed to send weight reminder via any channel")
	}

	// Update state with successful delivery
	return s.store.UpdateWeightReminderNotificationSent(userID, messageID)
}
