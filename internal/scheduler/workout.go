package scheduler

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	workoutsvc "github.com/korjavin/medicationtrackerbot/internal/workout"
)

// WorkoutStore is the subset needed for workout scheduling and notifications.
type WorkoutStore interface {
	GetWorkoutEnabled(ctx context.Context) (bool, error)
	GetWorkoutHistory(userID int64, limit int) ([]store.WorkoutSession, error)
	ListWorkoutGroups(userID int64, activeOnly bool) ([]store.WorkoutGroup, error)
	GetRotationState(groupID int64) (*store.WorkoutRotationState, error)
	ListVariantsByGroup(groupID int64) ([]store.WorkoutVariant, error)
	InitializeRotation(groupID, variantID int64) error
	GetSessionByGroupAndDate(groupID int64, date time.Time) (*store.WorkoutSession, error)
	CreateWorkoutSession(groupID, variantID, userID int64, date time.Time, scheduledTime string) (*store.WorkoutSession, error)
	GetWorkoutGroup(groupID int64) (*store.WorkoutGroup, error)
	UpdateSessionStatus(sessionID int64, status string) error
	UpdateWorkoutSessionNotes(sessionID int64, notes string) error
	ClearSnooze(sessionID int64) error
	GetWorkoutVariant(variantID int64) (*store.WorkoutVariant, error)
	ListExercisesByVariant(variantID int64) ([]store.WorkoutExercise, error)
	SetSessionNotificationMessageID(sessionID int64, msgID int) error
	UpdateSessionVariant(sessionID int64, variantID int64) error
	GetCurrentTimezone() (string, error)
	GetLatestSessionScheduledDate(groupID, userID int64) (time.Time, bool, error)
	ListPendingAdHocSessions(userID int64, before time.Time) ([]store.WorkoutSession, error)
	GetExerciseLogs(sessionID int64) ([]store.WorkoutExerciseLog, error)
}

// crossTZSessionCooldown is the minimum gap between two scheduled_dates for
// the same workout group below which the scheduler refuses to materialise a
// new session — even when the calendar date in the user's CURRENT timezone
// suggests one is due. Two scheduler ticks running in two different user
// timezones can otherwise both compute "today" against different calendar
// dates and produce duplicate sessions for what the user perceives as one
// workout day. 18h leaves room for legitimate consecutive-day workouts at
// the same scheduled time (24h apart) and shorter weekly cycles, while
// blocking the typical TZ-shift fingerprint of 6–12 hours.
const crossTZSessionCooldown = 18 * time.Hour

// WorkoutChecker checks for scheduled workouts and sends notifications.
type WorkoutChecker struct {
	NotifyHelper
	store      WorkoutStore
	workoutSvc workoutsvc.WorkoutService

	daysCache   map[string][]int
	daysCacheMu sync.RWMutex
	now         func() time.Time // mock clock
}

func (c *WorkoutChecker) Check(ctx context.Context) error {
	enabled, err := c.store.GetWorkoutEnabled(ctx)
	if err != nil {
		return err
	}
	if !enabled {
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

	// 1. Get history to check for InProgress and Stale sessions
	history, err := c.store.GetWorkoutHistory(c.allowedUserID, 20)
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
			c.Notify(ctx, n, nil)
			if err := c.store.UpdateWorkoutSessionNotes(activeSession.ID, activeSession.Notes+" stale_reminded"); err != nil {
				slog.Error("Failed to update session notes", "error", err)
			}
		}

		// Clear blocked state after 4 hours of inactivity
		if duration > 4*time.Hour {
			if err := c.workoutSvc.SkipSession(activeSession.ID); err != nil {
				slog.Error("Failed to skip stale session", "error", err)
			} else {
				if activeSession.NotificationMessageID != nil {
					c.DeleteNotification(ctx, *activeSession.NotificationMessageID)
				}
				activeSession = nil
			}
		}
	}

	// 3. Get all active workout groups for the user
	groups, err := c.store.ListWorkoutGroups(c.allowedUserID, true)
	if err != nil {
		return fmt.Errorf("failed to list workout groups: %w", err)
	}

	for _, group := range groups {
		// 4. Check if today matches one of the scheduled days
		todayIdx := int(now.Weekday())

		c.daysCacheMu.RLock()
		daysOfWeek, cached := c.daysCache[group.DaysOfWeek]
		c.daysCacheMu.RUnlock()

		if !cached {
			if err := json.Unmarshal([]byte(group.DaysOfWeek), &daysOfWeek); err != nil {
				slog.Error("Failed to parse days_of_week", "group", group.ID, "error", err)
				continue
			}
			c.daysCacheMu.Lock()
			if c.daysCache == nil {
				c.daysCache = make(map[string][]int)
			}
			c.daysCache[group.DaysOfWeek] = daysOfWeek
			c.daysCacheMu.Unlock()
		}

		if !contains(daysOfWeek, todayIdx) {
			continue
		}

		// 5. Parse scheduled time
		if len(group.ScheduledTime) != 5 {
			slog.Warn("Invalid scheduled_time format", "group", group.ID, "time", group.ScheduledTime)
			continue
		}

		hour := parseHour(group.ScheduledTime)
		minute := parseMinute(group.ScheduledTime)
		scheduledTime := time.Date(now.Year(), now.Month(), now.Day(), hour, minute, 0, 0, now.Location())

		// 6. Determine which variant to use
		var variantID int64
		if group.IsRotating {
			rotationState, err := c.store.GetRotationState(group.ID)
			if err != nil {
				slog.Error("Error getting rotation state", "group", group.ID, "error", err)
				continue
			}
			if rotationState == nil {
				variants, err := c.store.ListVariantsByGroup(group.ID)
				if err != nil || len(variants) == 0 {
					slog.Info("No variants found for rotating group", "group", group.ID)
					continue
				}
				if err := c.store.InitializeRotation(group.ID, variants[0].ID); err != nil {
					slog.Error("Failed to auto-initialize rotation", "group", group.ID, "error", err)
					continue
				}
				variantID = variants[0].ID
			} else {
				variantID = rotationState.CurrentVariantID
			}
		} else {
			variants, err := c.store.ListVariantsByGroup(group.ID)
			if err != nil || len(variants) == 0 {
				slog.Info("No variants found for group", "group", group.ID)
				continue
			}
			variantID = variants[0].ID
		}

		// 7. Check if session already exists for today
		today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
		existing, err := c.store.GetSessionByGroupAndDate(group.ID, today)
		if err != nil {
			slog.Error("Error checking for existing session", "error", err)
			continue
		}

		if existing == nil {
			// Cross-TZ idempotency: skip creating a fresh session if the most
			// recent session for this group is closer than the cooldown
			// window. The today-date lookup above only catches duplicates
			// keyed by the same calendar date string; after a westbound
			// flight "today" in the new TZ may be a different calendar date
			// from the session that just got created in the old TZ, and
			// without this guard the scheduler would happily double up.
			if latest, has, err := c.store.GetLatestSessionScheduledDate(group.ID, c.allowedUserID); err != nil {
				slog.Warn("Error checking latest session, ignoring cross-TZ cooldown", "group", group.ID, "error", err)
			} else if has {
				gap := today.Sub(latest)
				if gap < 0 {
					gap = -gap
				}
				if gap < crossTZSessionCooldown {
					slog.Info("Skipping workout session: within cross-TZ cooldown",
						"group", group.ID, "today", today, "latest", latest, "gap", gap)
					continue
				}
			}

			session, err := c.store.CreateWorkoutSession(group.ID, variantID, c.allowedUserID, today, group.ScheduledTime)
			if err != nil {
				slog.Error("Failed to create workout session", "error", err)
				continue
			}
			existing = session
		} else if existing.VariantID != variantID && (existing.Status == "pending" || existing.Status == "notified") {
			// The session was pre-created with a stale variant (e.g., group was converted from
			// non-rotating to rotating after the session was already created). Update it now
			// so the notification and the actual workout exercise list are consistent.
			slog.Info("Updating session variant (rotation changed)",
				"session", existing.ID, "oldVariant", existing.VariantID, "newVariant", variantID)
			if err := c.store.UpdateSessionVariant(existing.ID, variantID); err != nil {
				slog.Error("Failed to update session variant", "error", err)
			} else {
				existing.VariantID = variantID
			}
		}

		// 8. Handle pre_skipped sessions
		if existing.Status == "pre_skipped" {
			if now.After(scheduledTime) {
				if err := c.workoutSvc.SkipSession(existing.ID); err != nil {
					slog.Error("Failed to auto-skip pre_skipped session", "session", existing.ID, "error", err)
				}
			}
			continue
		}

		// 9. Handle Notifications
		advanceMinutes := group.NotificationAdvanceMinutes
		notifyTime := scheduledTime.Add(-time.Duration(advanceMinutes) * time.Minute)

		if existing.Status == "pending" {
			if activeSession != nil {
				continue
			}

			if now.After(notifyTime) {
				if err := c.sendWorkoutNotification(existing, &group, variantID); err != nil {
					slog.Error("Failed to send workout notification", "error", err)
				} else {
					if err := c.store.UpdateSessionStatus(existing.ID, "notified"); err != nil {
						slog.Error("Failed to update session status", "error", err)
					}
					continue
				}
			}
		}

		// 10. Check snoozed sessions for this group (Do this BEFORE 3h logic so wake-ups are prioritized)
		if existing.SnoozedUntil != nil && now.After(*existing.SnoozedUntil) {
			if activeSession == nil {
				if err := c.sendWorkoutNotification(existing, &group, variantID); err != nil {
					slog.Error("Failed to re-send snoozed notification", "error", err)
				} else {
					if err := c.store.ClearSnooze(existing.ID); err != nil {
						slog.Error("Failed to clear snooze state", "error", err)
					}
					// If the session was previously marked with "resent_3h", clear it out so that
					// waking from a snooze gives the user another full cycle before it auto-skips.
					if strings.Contains(existing.Notes, "resent_3h") {
						newNotes := strings.TrimSpace(strings.ReplaceAll(existing.Notes, "resent_3h", ""))
						if err := c.store.UpdateWorkoutSessionNotes(existing.ID, newNotes); err != nil {
							slog.Error("Failed to update session notes", "error", err)
						}
						existing.Notes = newNotes // ensure subsequent checks see updated notes
					}
					continue
				}
			}
		}

		// Handle re-notification for ignored sessions (3h logic)
		if existing.Status == "notified" {
			if now.After(scheduledTime.Add(3 * time.Hour)) {
				if !strings.Contains(existing.Notes, "resent_3h") {
					// If they are snoozed, we don't want to re-notify them as "ignored" while snoozing!
					if existing.SnoozedUntil == nil || now.After(*existing.SnoozedUntil) {
						if err := c.sendWorkoutNotification(existing, &group, variantID); err != nil {
							slog.Error("Failed to re-send 3h notification", "error", err)
						}
						if err := c.store.UpdateWorkoutSessionNotes(existing.ID, existing.Notes+" resent_3h"); err != nil {
							slog.Error("Failed to update session notes", "error", err)
						}
						continue
					}
				} else if now.After(scheduledTime.Add(6 * time.Hour)) {
					// Service handles skip + rotation advancement for rotating groups
					if err := c.workoutSvc.SkipSession(existing.ID); err != nil {
						slog.Error("Failed to skip session", "error", err)
					}
					if existing.NotificationMessageID != nil {
						c.DeleteNotification(ctx, *existing.NotificationMessageID)
					}
					continue
				}
			}
		}
	}

	// 11. Pre-scheduled ad-hoc sessions (group_id == -1, status == 'pending').
	// These have no group, no rotation, and no cross-TZ cooldown — just a
	// fixed scheduled_date + scheduled_time chosen by the user. Notify when
	// the moment is due, then flip status to 'notified'. Already-notified
	// ad-hoc sessions are picked up by the history-driven branch below.
	if err := c.checkPendingAdHocSessions(ctx, now, activeSession); err != nil {
		slog.Error("Failed to check pending ad-hoc workout sessions", "error", err)
	}

	// 12. Re-notification / auto-skip for already-notified ad-hoc sessions.
	// Mirrors the recurring 3h-resend / 6h-auto-skip behaviour for sessions
	// that have no group attached. Snooze wake-ups for ad-hoc are also
	// handled here so the user can defer a one-off the same way.
	c.checkNotifiedAdHocSessions(ctx, now, activeSession)

	return nil
}

// checkPendingAdHocSessions fires the initial notification for any
// pre-scheduled ad-hoc workout whose moment has arrived.
func (c *WorkoutChecker) checkPendingAdHocSessions(ctx context.Context, now time.Time, activeSession *store.WorkoutSession) error {
	if activeSession != nil {
		// Mirrors the recurring branch: don't pile a fresh notification on
		// top of a session the user is currently doing.
		return nil
	}
	pending, err := c.store.ListPendingAdHocSessions(c.allowedUserID, now)
	if err != nil {
		return fmt.Errorf("list pending ad-hoc sessions: %w", err)
	}
	for i := range pending {
		sess := &pending[i]
		if err := c.sendAdHocWorkoutNotification(ctx, sess); err != nil {
			slog.Error("Failed to send ad-hoc workout notification", "session", sess.ID, "error", err)
			continue
		}
		if err := c.store.UpdateSessionStatus(sess.ID, "notified"); err != nil {
			slog.Error("Failed to mark ad-hoc session notified", "session", sess.ID, "error", err)
		}
	}
	return nil
}

// checkNotifiedAdHocSessions handles snooze wake-ups, the 3h re-notify, and
// the 6h auto-skip for ad-hoc sessions that already received their first
// notification. We read from the recent history rather than introducing a new
// dedicated query because the volume is small and history is already loaded
// elsewhere — but call it a second time here so this path is independent of
// the groups loop above.
func (c *WorkoutChecker) checkNotifiedAdHocSessions(ctx context.Context, now time.Time, activeSession *store.WorkoutSession) {
	history, err := c.store.GetWorkoutHistory(c.allowedUserID, 50)
	if err != nil {
		slog.Error("Failed to load workout history for ad-hoc re-notify", "error", err)
		return
	}
	for i := range history {
		sess := &history[i]
		if sess.GroupID != -1 {
			continue
		}
		if sess.Status != "notified" {
			continue
		}

		scheduledMoment := adHocScheduledMoment(sess, now.Location())

		// Snooze wake-up: if a user snoozed and the snooze just elapsed,
		// re-fire the same ad-hoc notification.
		if sess.SnoozedUntil != nil && now.After(*sess.SnoozedUntil) {
			if activeSession != nil {
				continue
			}
			if err := c.sendAdHocWorkoutNotification(ctx, sess); err != nil {
				slog.Error("Failed to re-send snoozed ad-hoc notification", "session", sess.ID, "error", err)
				continue
			}
			if err := c.store.ClearSnooze(sess.ID); err != nil {
				slog.Error("Failed to clear ad-hoc snooze state", "session", sess.ID, "error", err)
			}
			if strings.Contains(sess.Notes, "resent_3h") {
				newNotes := strings.TrimSpace(strings.ReplaceAll(sess.Notes, "resent_3h", ""))
				if err := c.store.UpdateWorkoutSessionNotes(sess.ID, newNotes); err != nil {
					slog.Error("Failed to update ad-hoc session notes", "session", sess.ID, "error", err)
				}
			}
			continue
		}

		if now.After(scheduledMoment.Add(3 * time.Hour)) {
			if !strings.Contains(sess.Notes, "resent_3h") {
				if sess.SnoozedUntil == nil || now.After(*sess.SnoozedUntil) {
					if activeSession != nil {
						continue
					}
					if err := c.sendAdHocWorkoutNotification(ctx, sess); err != nil {
						slog.Error("Failed to re-send 3h ad-hoc notification", "session", sess.ID, "error", err)
					}
					if err := c.store.UpdateWorkoutSessionNotes(sess.ID, sess.Notes+" resent_3h"); err != nil {
						slog.Error("Failed to update ad-hoc session notes", "session", sess.ID, "error", err)
					}
				}
			} else if now.After(scheduledMoment.Add(6 * time.Hour)) {
				if err := c.workoutSvc.SkipSession(sess.ID); err != nil {
					slog.Error("Failed to skip ad-hoc session", "session", sess.ID, "error", err)
				}
				if sess.NotificationMessageID != nil {
					c.DeleteNotification(ctx, *sess.NotificationMessageID)
				}
			}
		}
	}
}

// adHocScheduledMoment combines a session's stored scheduled_date and
// scheduled_time into a single time.Time anchored to the supplied location.
// Falls back gracefully if scheduled_time is malformed.
//
// scheduled_date is persisted as UTC midnight on the user's intended calendar
// day (the HTTP handler parses YYYY-MM-DD via time.Parse, which yields UTC).
// We extract Y/M/D in UTC — re-localizing to a non-UTC zone before extraction
// would shift the calendar day by one for west-of-UTC users (e.g. "2030-06-15
// 00:00 UTC".In("America/New_York") = "2030-06-14 20:00 EDT", whose Day() is
// 14), which would make the 3h re-notify / 6h auto-skip fire against the
// wrong reference moment.
func adHocScheduledMoment(sess *store.WorkoutSession, loc *time.Location) time.Time {
	if loc == nil {
		loc = time.Local
	}
	d := sess.ScheduledDate.UTC()
	hh := parseHour(sess.ScheduledTime)
	mm := parseMinute(sess.ScheduledTime)
	return time.Date(d.Year(), d.Month(), d.Day(), hh, mm, 0, 0, loc)
}

// sendAdHocWorkoutNotification builds and dispatches the workout-due
// notification for a one-off scheduled ad-hoc session. Lists the planned
// exercises (sourced from workout_exercise_logs placeholders) when present,
// and falls back to a generic message when the user scheduled the session
// without any exercises.
func (c *WorkoutChecker) sendAdHocWorkoutNotification(_ context.Context, session *store.WorkoutSession) error {
	logs, err := c.store.GetExerciseLogs(session.ID)
	if err != nil {
		return fmt.Errorf("failed to list planned exercise logs: %w", err)
	}

	message := "🏋️ **Workout starting now**\n\n"
	if len(logs) > 0 {
		message += "Planned exercises:\n"
		for i, l := range logs {
			line := fmt.Sprintf("%d. **%s**", i+1, l.ExerciseName)
			message += line + "\n"
		}
	} else {
		message += "_No exercises planned — start when you're ready._\n"
	}

	if session.NotificationMessageID != nil {
		c.DeleteNotification(context.Background(), *session.NotificationMessageID)
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
			"ad_hoc":     true,
		},
	}

	sessionID := session.ID
	c.Notify(context.Background(), n, func(msgID int) {
		if err := c.store.SetSessionNotificationMessageID(sessionID, msgID); err != nil {
			slog.Error("Failed to store ad-hoc notification message ID", "error", err)
		}
	})
	return nil
}

// sendWorkoutNotification sends a workout notification via all notifiers.
func (c *WorkoutChecker) sendWorkoutNotification(session *store.WorkoutSession, group *store.WorkoutGroup, variantID int64) error {
	variant, err := c.store.GetWorkoutVariant(variantID)
	if err != nil || variant == nil {
		return fmt.Errorf("variant not found: %w", err)
	}

	exercises, err := c.store.ListExercisesByVariant(variantID)
	if err != nil {
		return fmt.Errorf("failed to list exercises: %w", err)
	}

	message := fmt.Sprintf("🏋️ **Workout starting in %d minutes**\n\n", group.NotificationAdvanceMinutes)
	message += fmt.Sprintf("**%s - %s**\n\n", group.Name, variant.Name)

	if len(exercises) > 0 {
		message += "Exercises:\n"
		for i, ex := range exercises {
			var repsStr string
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

	// Delete previous notification if exists
	if session.NotificationMessageID != nil {
		c.DeleteNotification(context.Background(), *session.NotificationMessageID)
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
	c.Notify(context.Background(), n, func(msgID int) {
		if err := c.store.SetSessionNotificationMessageID(sessionID, msgID); err != nil {
			slog.Error("Failed to store notification message ID", "error", err)
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
