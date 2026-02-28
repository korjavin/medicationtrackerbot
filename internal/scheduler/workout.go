package scheduler

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// checkWorkoutNotifications checks for scheduled workouts and sends notifications
func (s *Scheduler) checkWorkoutNotifications() error {
	enabled, err := s.store.GetWorkoutEnabled(context.Background())
	if err != nil {
		return err
	}
	if !enabled {
		return nil
	}

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
			n := notifier.Notification{
				Text: "🏋️ Still training? It's been 1.5 hours. Don't forget to log your results!",
				Actions: []notifier.Action{
					{ID: fmt.Sprintf("workout_finish_%d", activeSession.ID), Label: "Finish Workout"},
					{ID: "dismiss_notification", Label: "Dismiss"},
				},
				Tag: fmt.Sprintf("workout-stale-%d", activeSession.ID),
				Metadata: map[string]interface{}{
					"type":       "workout_stale",
					"session_id": activeSession.ID,
				},
			}
			s.notify(context.Background(), n, nil)
			if err := s.store.UpdateWorkoutSessionNotes(activeSession.ID, activeSession.Notes+" stale_reminded"); err != nil {
				log.Printf("Failed to update session notes: %v", err)
			}
		}

		// Clear blocked state after 4 hours of inactivity to prevent blocking next day's workouts
		if duration > 4*time.Hour {
			if err := s.store.SkipSession(activeSession.ID); err != nil {
				log.Printf("Failed to skip stale session: %v", err)
			} else {
				// Advance rotation for rotating groups when stale session is auto-skipped
				group, err := s.store.GetWorkoutGroup(activeSession.GroupID)
				if err == nil && group != nil && group.IsRotating {
					if err := s.store.AdvanceRotation(group.ID); err != nil {
						log.Printf("Failed to advance rotation after stale auto-skip for group %d: %v", group.ID, err)
					}
				}
				if activeSession.NotificationMessageID != nil {
					s.deleteNotification(context.Background(), *activeSession.NotificationMessageID)
				}
				activeSession = nil
			}
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

		// 8. Handle pre_skipped sessions: auto-skip at scheduled time, never notify
		if existing.Status == "pre_skipped" {
			if now.After(scheduledTime) {
				if err := s.store.SkipSession(existing.ID); err != nil {
					log.Printf("Failed to auto-skip pre_skipped session %d: %v", existing.ID, err)
				} else if group.IsRotating {
					if err := s.store.AdvanceRotation(group.ID); err != nil {
						log.Printf("Failed to advance rotation after auto-skip for group %d: %v", group.ID, err)
					}
				}
			}
			continue
		}

		// 9. Handle Notifications
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
					if err := s.store.UpdateSessionStatus(existing.ID, "notified"); err != nil {
						log.Printf("Failed to update session status: %v", err)
					}
				}
			}
		}

		// 9. Handle re-notification for ignored sessions (3h logic)
		if existing.Status == "notified" {
			if now.After(scheduledTime.Add(3 * time.Hour)) {
				if !strings.Contains(existing.Notes, "resent_3h") {
					if err := s.sendWorkoutNotification(existing, &group, variantID); err != nil {
						log.Printf("Failed to re-send 3h notification: %v", err)
					}
					if err := s.store.UpdateWorkoutSessionNotes(existing.ID, existing.Notes+" resent_3h"); err != nil {
						log.Printf("Failed to update session notes: %v", err)
					}
				} else if now.After(scheduledTime.Add(6 * time.Hour)) {
					// Auto-skip after 6 hours of silence
					if err := s.store.SkipSession(existing.ID); err != nil {
						log.Printf("Failed to skip session: %v", err)
					}
					if existing.NotificationMessageID != nil {
						s.deleteNotification(context.Background(), *existing.NotificationMessageID)
					}
				}
			}
		}

		// 10. Check snoozed sessions for this group
		if existing.SnoozedUntil != nil && now.After(*existing.SnoozedUntil) {
			if activeSession == nil {
				if err := s.sendWorkoutNotification(existing, &group, variantID); err != nil {
					log.Printf("Failed to re-send snoozed notification: %v", err)
				} else {
					// Clear snoozed_until to prevent sending notifications every minute
					// The notification has been sent, so we reset the snooze state
					if err := s.store.ClearSnooze(existing.ID); err != nil {
						log.Printf("Failed to clear snooze state: %v", err)
					}
				}
			}
		}
	}
	return nil
}

// sendWorkoutNotification sends a workout notification via all notifiers
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

	// Delete previous notification if exists to avoid clutter
	if session.NotificationMessageID != nil {
		s.deleteNotification(context.Background(), *session.NotificationMessageID)
	}

	n := notifier.Notification{
		Text: message,
		Actions: []notifier.Action{
			{ID: fmt.Sprintf("workout_start_%d", session.ID), Label: "▶️ Start Now"},
			{ID: fmt.Sprintf("workout_snooze1_%d", session.ID), Label: "⏰ Snooze 1h"},
			{ID: fmt.Sprintf("workout_snooze2_%d", session.ID), Label: "⏰ Snooze 2h"},
			{ID: fmt.Sprintf("workout_skip_%d", session.ID), Label: "⏭ Skip"},
		},
		Tag: fmt.Sprintf("workout-%d", session.ID),
		Metadata: map[string]interface{}{
			"type":       "workout",
			"session_id": session.ID,
			"group_name": group.Name,
			"variant":    variant.Name,
		},
	}

	sessionID := session.ID
	s.notify(context.Background(), n, func(msgID int) {
		if err := s.store.SetSessionNotificationMessageID(sessionID, msgID); err != nil {
			log.Printf("Failed to store notification message ID: %v", err)
		}
	})

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
	_, _ = fmt.Sscanf(timeStr[:2], "%d", &h)
	return h
}

func parseMinute(timeStr string) int {
	if len(timeStr) < 5 {
		return 0
	}
	m := 0
	_, _ = fmt.Sscanf(timeStr[3:5], "%d", &m)
	return m
}
