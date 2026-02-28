package scheduler

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// checkBPReminders checks if any users need BP reminder notifications
func (s *Scheduler) checkBPReminders() error {
	enabled, err := s.bpReminders.GetBloodPressureEnabled(context.Background())
	if err != nil {
		return err
	}
	if !enabled {
		return nil
	}

	// Get all users with BP reminders enabled
	userIDs, err := s.bpReminders.GetUsersForBPReminders()
	if err != nil {
		return err
	}

	ctx := context.Background()
	now := time.Now()

	for _, userID := range userIDs {
		// Get reminder state
		state, err := s.bpReminders.GetBPReminderState(userID)
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
		lastReading, err := s.bpReminders.GetLastBPReading(ctx, userID)
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
		preferredHour, err := s.bpReminders.CalculatePreferredReminderHour(ctx, userID)
		if err != nil {
			log.Printf("Error calculating preferred hour for user %d: %v", userID, err)
			preferredHour = 20 // Fallback to default
		}

		// Update if different from stored value
		if preferredHour != state.PreferredReminderHour {
			if err := s.bpReminders.UpdatePreferredReminderHour(userID, preferredHour); err != nil {
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
		dominantCategory, err := s.bpReminders.GetDominantBPCategory(ctx, userID)
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

// sendBPReminder sends a BP reminder notification via all notifiers
func (s *Scheduler) sendBPReminder(ctx context.Context, userID int64, enhanced bool) error {
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

	for _, nr := range s.notifiers {
		msgID, err := nr.Send(ctx, userID, n)
		if err != nil {
			log.Printf("Failed to send BP reminder via %T: %v", nr, err)
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

	// Update state with successful delivery
	var messageID *int
	if firstMsgID != 0 {
		messageID = &firstMsgID
	}
	return s.bpReminders.UpdateBPReminderNotificationSent(userID, messageID)
}
