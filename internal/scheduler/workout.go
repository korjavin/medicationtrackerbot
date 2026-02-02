package scheduler

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notification"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// checkWorkoutNotifications checks for scheduled workouts and sends notifications
func (s *Scheduler) checkWorkoutNotifications() error {
	now := time.Now()

	// 1. Get history to check for InProgress and Stale sessions
	history, err := s.store.GetWorkoutHistory(s.allowedUserID, 20)
	if err != nil {
		return fmt.Errorf("failed to get workout history: %w", err)
	}

	var activeSession *store.WorkoutSession
	for _, sess := range history {
		if sess.Status == "in_progress" {
			activeSession = &sess
			break
		}
	}

	// 2. Handle stale active session (started but forgotten)
	if activeSession != nil && activeSession.StartedAt != nil {
		duration := now.Sub(*activeSession.StartedAt)
		if duration > 90*time.Minute && !strings.Contains(activeSession.Notes, "stale_reminded") {
			// Send stale reminder via notification service
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			err := s.notifService.SendSimpleMessage(ctx, s.allowedUserID,
				"🏋️ Still training? It's been 1.5 hours. Don't forget to log your results!",
				notification.TypeWorkout)
			cancel()
			if err != nil {
				log.Printf("Failed to send stale workout reminder: %v", err)
			}
			s.store.UpdateWorkoutSessionNotes(activeSession.ID, activeSession.Notes+" stale_reminded")
		}

		// Clear blocked state after 4 hours of inactivity to prevent blocking next day's workouts
		if duration > 4*time.Hour {
			s.store.SkipSession(activeSession.ID)
			// Delete notification message via notification service (Telegram only)
			if activeSession.NotificationMessageID != nil {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				s.notifService.RemoveNotification(ctx, "telegram", *activeSession.NotificationMessageID)
				cancel()
			}
			activeSession = nil
		}
	}

	// 3. Get all active workout groups for the user
	groups, err := s.store.ListWorkoutGroups(s.allowedUserID, true)
	if err != nil {
		return fmt.Errorf("failed to list workout groups: %w", err)
	}

	for _, group := range groups {
		// 4. Check if today matches one of the scheduled days
		todayIdx := int(now.Weekday())

		var daysOfWeek []int
		if err := json.Unmarshal([]byte(group.DaysOfWeek), &daysOfWeek); err != nil {
			log.Printf("Failed to parse days_of_week for group %d: %v", group.ID, err)
			continue
		}

		if !contains(daysOfWeek, todayIdx) {
			continue
		}

		// 5. Parse scheduled time
		if len(group.ScheduledTime) != 5 {
			log.Printf("Invalid scheduled_time format for group %d: %s", group.ID, group.ScheduledTime)
			continue
		}

		hour := parseHour(group.ScheduledTime)
		minute := parseMinute(group.ScheduledTime)
		scheduledTime := time.Date(now.Year(), now.Month(), now.Day(), hour, minute, 0, 0, now.Location())

		// 6. Determine which variant to use
		var variantID int64
		if group.IsRotating {
			rotationState, err := s.store.GetRotationState(group.ID)
			if err != nil {
				log.Printf("Error getting rotation state for group %d: %v", group.ID, err)
				continue
			}
			if rotationState == nil {
				// Auto-initialize with first variant
				variants, err := s.store.ListVariantsByGroup(group.ID)
				if err != nil || len(variants) == 0 {
					log.Printf("No variants found for rotating group %d", group.ID)
					continue
				}
				if err := s.store.InitializeRotation(group.ID, variants[0].ID); err != nil {
					log.Printf("Failed to auto-initialize rotation for group %d: %v", group.ID, err)
					continue
				}
				variantID = variants[0].ID
			} else {
				variantID = rotationState.CurrentVariantID
			}
		} else {
			variants, err := s.store.ListVariantsByGroup(group.ID)
			if err != nil || len(variants) == 0 {
				log.Printf("No variants found for group %d", group.ID)
				continue
			}
			variantID = variants[0].ID
		}

		// 7. Check if session already exists for today
		today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
		existing, err := s.store.GetSessionByGroupAndDate(group.ID, today)
		if err != nil {
			log.Printf("Error checking for existing session: %v", err)
			continue
		}

		if existing == nil {
			session, err := s.store.CreateWorkoutSession(group.ID, variantID, s.allowedUserID, today, group.ScheduledTime)
			if err != nil {
				log.Printf("Failed to create workout session: %v", err)
				continue
			}
			existing = session
		}

		// 8. Handle Notifications
		advanceMinutes := group.NotificationAdvanceMinutes
		notifyTime := scheduledTime.Add(-time.Duration(advanceMinutes) * time.Minute)

		if existing.Status == "pending" {
			// Don't send new notifications if ANY workout is already in progress
			if activeSession != nil {
				continue
			}

			if now.After(notifyTime) {
				if err := s.sendWorkoutNotification(existing, &group, variantID); err != nil {
					log.Printf("Failed to send workout notification: %v", err)
				} else {
					s.store.UpdateSessionStatus(existing.ID, "notified")
				}
			}
		}

		// 9. Handle re-notification for ignored sessions (3h logic)
		if existing.Status == "notified" {
			if now.After(scheduledTime.Add(3 * time.Hour)) {
				if !strings.Contains(existing.Notes, "resent_3h") {
					s.sendWorkoutNotification(existing, &group, variantID)
					s.store.UpdateWorkoutSessionNotes(existing.ID, existing.Notes+" resent_3h")
				} else if now.After(scheduledTime.Add(6 * time.Hour)) {
					// Auto-skip after 6 hours of silence
					s.store.SkipSession(existing.ID)
					if existing.NotificationMessageID != nil {
						ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
						s.notifService.RemoveNotification(ctx, "telegram", *existing.NotificationMessageID)
						cancel()
					}
				}
			}
		}

		// 10. Check snoozed sessions for this group
		if existing.SnoozedUntil != nil && now.After(*existing.SnoozedUntil) {
			if activeSession == nil {
				if err := s.sendWorkoutNotification(existing, &group, variantID); err != nil {
					log.Printf("Failed to re-send snoozed notification: %v", err)
				}
				// Note: snooze is typically cleared on user interaction
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

	// Send via notification service
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	notif := notification.NotificationContext{
		Type:  notification.TypeWorkout,
		Title: fmt.Sprintf("🏋️ %s - %s", group.Name, variant.Name),
		Body:  message,
		Tag:   fmt.Sprintf("workout_%d", session.ID),
		Data: map[string]interface{}{
			"session": session,
			"group":   group,
			"variant": variant,
		},
	}

	if err := s.notifService.Send(ctx, s.allowedUserID, notif); err != nil {
		log.Printf("Failed to send workout notification: %v", err)
		return err
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
