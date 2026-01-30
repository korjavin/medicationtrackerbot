package scheduler

import (
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// checkWorkoutNotifications checks for scheduled workouts and sends notifications
func (s *Scheduler) checkWorkoutNotifications() error {
	now := time.Now()

	// 1. Get all active workout groups for the user
	groups, err := s.store.ListWorkoutGroups(s.allowedUserID, true)
	if err != nil {
		return fmt.Errorf("failed to list workout groups: %w", err)
	}

	for _, group := range groups {
		// 2. Check if today matches one of the scheduled days
		todayIdx := int(now.Weekday()) // 0=Sunday, 1=Monday, etc.

		var daysOfWeek []int
		if err := json.Unmarshal([]byte(group.DaysOfWeek), &daysOfWeek); err != nil {
			log.Printf("Failed to parse days_of_week for group %d: %v", group.ID, err)
			continue
		}

		if !contains(daysOfWeek, todayIdx) {
			continue // Not scheduled for today
		}

		// 3. Parse scheduled time
		if len(group.ScheduledTime) != 5 {
			log.Printf("Invalid scheduled_time format for group %d: %s", group.ID, group.ScheduledTime)
			continue
		}

		hour := parseHour(group.ScheduledTime)
		minute := parseMinute(group.ScheduledTime)
		scheduledTime := time.Date(now.Year(), now.Month(), now.Day(), hour, minute, 0, 0, now.Location())

		// 4. Determine which variant to use
		var variantID int64
		if group.IsRotating {
			// Get current rotation state
			rotationState, err := s.store.GetRotationState(group.ID)
			if err != nil {
				log.Printf("Error getting rotation state for group %d: %v", group.ID, err)
				continue
			}
			if rotationState == nil {
				log.Printf("No rotation state for rotating group %d", group.ID)
				continue
			}
			variantID = rotationState.CurrentVariantID
		} else {
			// Non-rotating: get the single default variant
			variants, err := s.store.ListVariantsByGroup(group.ID)
			if err != nil {
				log.Printf("Error listing variants for group %d: %v", group.ID, err)
				continue
			}
			if len(variants) == 0 {
				log.Printf("No variants found for group %d", group.ID)
				continue
			}
			variantID = variants[0].ID
		}

		// 5. Check if session already exists for today
		today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
		existing, err := s.store.GetSessionByGroupAndDate(group.ID, today)
		if err != nil {
			log.Printf("Error checking for existing session: %v", err)
			continue
		}

		if existing == nil {
			// Create pending session
			session, err := s.store.CreateWorkoutSession(
				group.ID,
				variantID,
				s.allowedUserID,
				today,
				group.ScheduledTime,
			)
			if err != nil {
				log.Printf("Failed to create workout session: %v", err)
				continue
			}
			existing = session
			log.Printf("Created workout session %d for group %s", session.ID, group.Name)
		}

		// 6. Check if it's time to send notification
		advanceMinutes := group.NotificationAdvanceMinutes
		notifyTime := scheduledTime.Add(-time.Duration(advanceMinutes) * time.Minute)

		if now.After(notifyTime) && existing.Status == "pending" {
			// Send advance notification
			if err := s.sendWorkoutNotification(existing, &group, variantID); err != nil {
				log.Printf("Failed to send workout notification: %v", err)
			} else {
				// Update status to notified
				if err := s.store.UpdateSessionStatus(existing.ID, "notified"); err != nil {
					log.Printf("Failed to update session status: %v", err)
				}
			}
		}

		// 7. Check snoozed sessions
		if existing.SnoozedUntil != nil && now.After(*existing.SnoozedUntil) {
			// Re-send notification
			if err := s.sendWorkoutNotification(existing, &group, variantID); err != nil {
				log.Printf("Failed to re-send snoozed notification: %v", err)
			}
			// Note: snooze is cleared when user interacts with notification
		}
	}

	// Also check for snoozed sessions across all groups
	snoozedSessions, err := s.store.GetSnoozedSessions(s.allowedUserID)
	if err != nil {
		log.Printf("Error getting snoozed sessions: %v", err)
		return nil
	}

	for _, session := range snoozedSessions {
		if session.SnoozedUntil != nil && now.After(*session.SnoozedUntil) {
			group, err := s.store.GetWorkoutGroup(session.GroupID)
			if err != nil || group == nil {
				continue
			}

			if err := s.sendWorkoutNotification(&session, group, session.VariantID); err != nil {
				log.Printf("Failed to re-send snoozed notification for session %d: %v", session.ID, err)
			}
		}
	}

	return nil
}

// sendWorkoutNotification sends a workout notification via the bot
func (s *Scheduler) sendWorkoutNotification(session *store.WorkoutSession, group *store.WorkoutGroup, variantID int64) error {
	// Get variant details
	variant, err := s.store.GetWorkoutVariant(variantID)
	if err != nil || variant == nil {
		return fmt.Errorf("variant not found: %w", err)
	}

	// Get exercises for this variant
	exercises, err := s.store.ListExercisesByVariant(variantID)
	if err != nil {
		return fmt.Errorf("failed to list exercises: %w", err)
	}

	// Build notification message
	message := fmt.Sprintf("🏋️ **Workout starting in %d minutes**\n\n", group.NotificationAdvanceMinutes)
	message += fmt.Sprintf("**%s - %s**\n\n", group.Name, variant.Name)

	if len(exercises) > 0 {
		message += "Exercises:\n"
		for i, ex := range exercises {
			repsStr := fmt.Sprintf("%d", ex.TargetSets)
			if ex.TargetRepsMax != nil && *ex.TargetRepsMax != ex.TargetRepsMin {
				repsStr = fmt.Sprintf("%d-%d", ex.TargetRepsMin, *ex.TargetRepsMax)
			} else {
				repsStr = fmt.Sprintf("%d", ex.TargetRepsMin)
			}
			message += fmt.Sprintf("%d. **%s**: %d × %s", i+1, ex.ExerciseName, ex.TargetSets, repsStr)
			if ex.TargetWeightKg != nil {
				message += fmt.Sprintf(" @ %.0fkg", *ex.TargetWeightKg)
			}
			message += "\n"
		}
	}

	// Send notification with inline buttons via bot
	messageID, err := s.bot.SendWorkoutNotification(message, session.ID)
	if err != nil {
		return err
	}

	// Store message ID for later editing
	if err := s.store.SetSessionNotificationMessageID(session.ID, messageID); err != nil {
		log.Printf("Failed to store notification message ID: %v", err)
	}

	return nil
}

// Helper functions
func contains(slice []int, val int) bool {
	for _, item := range slice {
		if item == val {
			return true
		}
	}
	return false
}

func parseHour(timeStr string) int {
	if len(timeStr) < 2 {
		return 0
	}
	h := 0
	fmt.Sscanf(timeStr[:2], "%d", &h)
	return h
}

func parseMinute(timeStr string) int {
	if len(timeStr) < 5 {
		return 0
	}
	m := 0
	fmt.Sscanf(timeStr[3:5], "%d", &m)
	return m
}
