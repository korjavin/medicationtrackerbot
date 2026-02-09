package scheduler

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// checkBPReminders checks if any users need BP reminder notifications
func (s *Scheduler) checkBPReminders() error {
	// Get all users with BP reminders enabled
	userIDs, err := s.store.GetUsersForBPReminders()
	if err != nil {
		return err
	}

	ctx := context.Background()
	now := time.Now()

	for _, userID := range userIDs {
		// Get reminder state
		state, err := s.store.GetBPReminderState(userID)
		if err != nil {
			log.Printf("Error getting BP reminder state for user %d: %v", userID, err)
			continue
		}

		// Check if reminders are enabled
		if !state.Enabled {
			continue
		}

		// Check if snoozed
		if state.SnoozedUntil != nil && now.Before(*state.SnoozedUntil) {
			continue
		}

		// Check if "don't bug me" is active
		if state.DontRemindUntil != nil && now.Before(*state.DontRemindUntil) {
			continue
		}

		// Get last BP reading
		lastReading, err := s.store.GetLastBPReading(ctx, userID)
		if err != nil {
			log.Printf("Error getting last BP reading for user %d: %v", userID, err)
			continue
		}

		// Check if no reading today
		todayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
		if lastReading != nil && lastReading.MeasuredAt.After(todayStart) {
			// Already measured today, skip
			continue
		}

		// Check if at least 12 hours since last reading
		if lastReading != nil && time.Since(lastReading.MeasuredAt) < 12*time.Hour {
			continue
		}

		// Calculate preferred reminder hour dynamically
		preferredHour, err := s.store.CalculatePreferredReminderHour(ctx, userID)
		if err != nil {
			log.Printf("Error calculating preferred hour for user %d: %v", userID, err)
			preferredHour = 20 // Fallback to default
		}

		// Update if different from stored value
		if preferredHour != state.PreferredReminderHour {
			if err := s.store.UpdatePreferredReminderHour(userID, preferredHour); err != nil {
				log.Printf("Error updating preferred hour for user %d: %v", userID, err)
			}
		}

		// Check if current time is within ±1 hour of preferred time
		currentHour := now.Hour()
		if currentHour < preferredHour-1 || currentHour > preferredHour+1 {
			continue
		}

		// Check if we already sent a notification today
		if state.LastNotificationSentAt != nil {
			lastSentDay := time.Date(state.LastNotificationSentAt.Year(), state.LastNotificationSentAt.Month(), state.LastNotificationSentAt.Day(), 0, 0, 0, 0, state.LastNotificationSentAt.Location())
			if !lastSentDay.Before(todayStart) {
				// Already sent today
				continue
			}
		}

		// Check if BP is above average (by category)
		shouldSendEnhanced := false
		dominantCategory, err := s.store.GetDominantBPCategory(ctx, userID)
		if err != nil {
			log.Printf("Error getting dominant BP category for user %d: %v", userID, err)
		} else if lastReading != nil {
			// Compare last reading category with dominant category
			lastSeverity := store.CategorySeverity(lastReading.Category)
			dominantSeverity := store.CategorySeverity(dominantCategory)

			if lastSeverity > dominantSeverity {
				shouldSendEnhanced = true
			}
		}

		// Send reminder notification
		if err := s.sendBPReminder(ctx, userID, shouldSendEnhanced); err != nil {
			log.Printf("Error sending BP reminder to user %d: %v", userID, err)
			continue
		}

		log.Printf("Sent BP reminder to user %d (enhanced: %v)", userID, shouldSendEnhanced)
	}

	return nil
}

// sendBPReminder sends a BP reminder notification via Telegram and Web Push
func (s *Scheduler) sendBPReminder(ctx context.Context, userID int64, enhanced bool) error {
	var messageID *int
	telegramSuccess := false
	webPushSuccess := false

	// Send Telegram notification
	if s.bot != nil {
		msgID, err := s.bot.SendBPReminderNotification(userID, enhanced)
		if err != nil {
			log.Printf("Failed to send Telegram BP reminder: %v", err)
		} else {
			messageID = &msgID
			telegramSuccess = true
		}
	}

	// Send Web Push notification
	if s.webPush != nil {
		if err := s.webPush.SendBPReminderNotification(ctx, userID, enhanced); err != nil {
			log.Printf("Failed to send Web Push BP reminder: %v", err)
		} else {
			webPushSuccess = true
		}
	}

	// Only update state if at least one channel succeeded
	if !telegramSuccess && !webPushSuccess {
		return fmt.Errorf("failed to send BP reminder via any channel")
	}

	// Update state with successful delivery
	return s.store.UpdateBPReminderNotificationSent(userID, messageID)
}
