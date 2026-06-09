package workout

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// NextWorkout is the response shape for GetNext. The top-level fields carry the
// resolved group/variant metadata; Session is a map that reproduces, byte-for-byte,
// the anonymous session object the HTTP handler historically emitted. It is kept as a
// map (rather than a typed struct) because the three priority branches differ in
// whether they include the snoozed_until key — the active-today and snoozed branches
// always emit it (possibly null), the pending branch omits it entirely.
type NextWorkout struct {
	Session        map[string]interface{} `json:"session"`
	GroupName      string                 `json:"group_name"`
	VariantName    string                 `json:"variant_name"`
	ExercisesCount int                    `json:"exercises_count"`
	VariantID      int64                  `json:"variant_id"`
	GroupID        int64                  `json:"group_id"`
	IsRotating     bool                   `json:"is_rotating"`
}

// CreateSessionError wraps a failure to lazily create the pending session that the
// next-workout engine surfaces. The HTTP handler maps it to a 500 with the legacy
// "Error creating session: <err>" body while every other GetNext error maps to a
// plain 500 carrying the underlying error string.
type CreateSessionError struct{ Err error }

func (e *CreateSessionError) Error() string { return "create next session: " + e.Err.Error() }

func (e *CreateSessionError) Unwrap() error { return e.Err }

// nextCandidate is the in-flight pick for the pending (scheduled) branch.
type nextCandidate struct {
	SessionID      int64
	GroupID        int64
	GroupName      string
	VariantID      int64
	VariantName    string
	ScheduledDate  time.Time
	ScheduledTime  string
	ExercisesCount int
	Status         string
	IsRotating     bool
}

// GetNext resolves the next workout to surface via a 3-priority engine:
//  0. an active session scheduled for today (notified or in_progress) — keeps a
//     workout visible even after its scheduled time has passed;
//  1. the earliest snoozed session whose snooze has elapsed;
//  2. the earliest upcoming scheduled occurrence across the next two weeks,
//     lazily materializing its session row so the frontend has an ID to /start.
//
// Returns (nil, nil) when nothing is upcoming. Date boundaries are computed in the
// user's stored timezone (UTC fallback), using the injectable Now clock.
func (s *Service) GetNext(userID int64) (*NextWorkout, error) {
	now := s.localNow()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())

	// PRIORITY 0: active sessions today (notified or in_progress). Errors here are
	// swallowed — we simply fall through to the lower-priority branches.
	if activeSessions, err := s.store.ListActiveSessions(userID, today); err == nil && len(activeSessions) > 0 {
		// Already ordered by scheduled_time ASC — surface the earliest.
		session := &activeSessions[0]
		return s.buildSessionResponse(session, today, session.SnoozedUntil != nil), nil
	}

	// PRIORITY 1: snoozed sessions whose snooze has elapsed.
	if snoozedSessions, err := s.store.ListSnoozedSessions(userID); err == nil && len(snoozedSessions) > 0 {
		var earliestSnoozed *store.WorkoutSession
		for i := range snoozedSessions {
			session := &snoozedSessions[i]
			if session.SnoozedUntil != nil && session.SnoozedUntil.Before(now) {
				if earliestSnoozed == nil || session.SnoozedUntil.Before(*earliestSnoozed.SnoozedUntil) {
					earliestSnoozed = session
				}
			}
		}
		if earliestSnoozed != nil {
			return s.buildSessionResponse(earliestSnoozed, today, true), nil
		}
	}

	// PRIORITY 2: fall back to scheduled workouts across all active groups.
	groups, err := s.store.ListGroups(userID, true)
	if err != nil {
		return nil, err
	}

	var nextWorkout *nextCandidate
	var earliestTime time.Time

	for _, group := range groups {
		var daysOfWeek []int
		if err := json.Unmarshal([]byte(group.DaysOfWeek), &daysOfWeek); err != nil {
			continue
		}

		// Find the next occurrence of this workout within the next 2 weeks.
		for daysAhead := 0; daysAhead < 14; daysAhead++ {
			checkDate := now.AddDate(0, 0, daysAhead)
			dayOfWeek := int(checkDate.Weekday())

			if !contains(daysOfWeek, dayOfWeek) {
				continue
			}

			var hour, minute int
			if _, err := fmt.Sscanf(group.ScheduledTime, "%d:%d", &hour, &minute); err != nil {
				continue
			}

			scheduledDateTime := time.Date(checkDate.Year(), checkDate.Month(), checkDate.Day(), hour, minute, 0, 0, now.Location())

			// Skip if this time has already passed.
			if scheduledDateTime.Before(now) {
				continue
			}

			// Only consider it if it beats the current candidate.
			if nextWorkout == nil || scheduledDateTime.Before(earliestTime) {
				variantID := s.resolveVariantID(group)
				if variantID == 0 {
					continue
				}

				variant, _ := s.store.GetVariant(variantID)
				if variant == nil {
					continue
				}

				exercises, _ := s.store.ListExercisesByVariant(variantID)

				// Check for an existing session for this date.
				sessionDate := time.Date(checkDate.Year(), checkDate.Month(), checkDate.Day(), 0, 0, 0, 0, now.Location())
				existing, _ := s.store.GetSessionByGroupAndDate(group.ID, sessionDate)

				status := "pending"
				var sessionID int64
				if existing != nil {
					// Completed/skipped sessions are not upcoming — keep scanning.
					if existing.Status == "completed" || existing.Status == "skipped" {
						continue
					}
					status = existing.Status
					sessionID = existing.ID
				}

				nextWorkout = &nextCandidate{
					SessionID:      sessionID,
					GroupID:        group.ID,
					GroupName:      group.Name,
					VariantID:      variantID,
					VariantName:    variant.Name,
					ScheduledDate:  scheduledDateTime,
					ScheduledTime:  group.ScheduledTime,
					ExercisesCount: len(exercises),
					Status:         status,
					IsRotating:     group.IsRotating,
				}
				earliestTime = scheduledDateTime
			}

			break // Found next occurrence for this group, move on.
		}
	}

	if nextWorkout == nil {
		return nil, nil
	}

	// Lazily create the session if it doesn't exist yet, so the frontend has a
	// valid ID to call /start on.
	if nextWorkout.SessionID == 0 {
		dateOnly := time.Date(nextWorkout.ScheduledDate.Year(), nextWorkout.ScheduledDate.Month(), nextWorkout.ScheduledDate.Day(), 0, 0, 0, 0, nextWorkout.ScheduledDate.Location())
		newSession, err := s.store.CreateSession(
			nextWorkout.GroupID,
			nextWorkout.VariantID,
			userID,
			dateOnly,
			nextWorkout.ScheduledTime,
		)
		if err != nil {
			return nil, &CreateSessionError{Err: err}
		}
		nextWorkout.SessionID = newSession.ID
		nextWorkout.Status = newSession.Status
	}

	return &NextWorkout{
		Session: map[string]interface{}{
			"id":             nextWorkout.SessionID,
			"scheduled_date": nextWorkout.ScheduledDate,
			"scheduled_time": nextWorkout.ScheduledTime,
			"status":         nextWorkout.Status,
			"is_snoozed":     false,
			"is_today":       nextWorkout.ScheduledDate.Format("2006-01-02") == today.Format("2006-01-02"),
		},
		GroupName:      nextWorkout.GroupName,
		VariantName:    nextWorkout.VariantName,
		ExercisesCount: nextWorkout.ExercisesCount,
		VariantID:      nextWorkout.VariantID,
		GroupID:        nextWorkout.GroupID,
		IsRotating:     nextWorkout.IsRotating,
	}, nil
}

// localNow returns the current time adjusted into the user's stored timezone. When
// no timezone is set (or it fails to load) it returns the clock time unchanged,
// matching the legacy handler's fall-through behavior.
func (s *Service) localNow() time.Time {
	now := s.Now()
	if s.tz != nil {
		if tzStr, tzErr := s.tz.GetCurrent(); tzErr == nil && tzStr != "" {
			if loc, locErr := time.LoadLocation(tzStr); locErr == nil {
				now = now.In(loc)
			}
		}
	}
	return now
}

// resolveVariantID picks the variant to surface for a group: the rotation's current
// variant for rotating groups (falling back to the first variant), otherwise the
// first variant. Returns 0 when the group has no variants.
func (s *Service) resolveVariantID(group store.WorkoutGroup) int64 {
	if group.IsRotating {
		if rotationState, _ := s.store.GetRotationState(group.ID); rotationState != nil {
			return rotationState.CurrentVariantID
		}
	}
	if variants, _ := s.store.ListVariantsByGroup(group.ID); len(variants) > 0 {
		return variants[0].ID
	}
	return 0
}

// buildSessionResponse assembles the NextWorkout for the active-today and snoozed
// branches. Both always emit snoozed_until (possibly null). isSnoozed sets the
// is_snoozed flag: the active branch passes (SnoozedUntil != nil), the snoozed
// branch passes true. Ad-hoc sessions (group_id == -1) have no variant, so their
// exercise count comes from placeholder workout_exercise_logs.
func (s *Service) buildSessionResponse(session *store.WorkoutSession, today time.Time, isSnoozed bool) *NextWorkout {
	group, _ := s.store.GetGroup(session.GroupID)
	variant, _ := s.store.GetVariant(session.VariantID)
	exercises, _ := s.store.ListExercisesByVariant(session.VariantID)

	groupName := "Unknown"
	variantName := "Unknown"
	if group != nil {
		groupName = group.Name
	}
	if variant != nil {
		variantName = variant.Name
	}

	exerciseCount := len(exercises)
	if session.GroupID == -1 {
		logs, _ := s.store.ListExerciseLogs(session.ID)
		exerciseCount = len(logs)
	}

	isRotating := group != nil && group.IsRotating
	return &NextWorkout{
		Session: map[string]interface{}{
			"id":             session.ID,
			"scheduled_date": session.ScheduledDate,
			"scheduled_time": session.ScheduledTime,
			"status":         session.Status,
			"is_snoozed":     isSnoozed,
			"snoozed_until":  session.SnoozedUntil,
			"is_today":       session.ScheduledDate.Format("2006-01-02") == today.Format("2006-01-02"),
		},
		GroupName:      groupName,
		VariantName:    variantName,
		ExercisesCount: exerciseCount,
		VariantID:      session.VariantID,
		GroupID:        session.GroupID,
		IsRotating:     isRotating,
	}
}

// contains reports whether val is present in slice.
func contains(slice []int, val int) bool {
	for _, item := range slice {
		if item == val {
			return true
		}
	}
	return false
}
