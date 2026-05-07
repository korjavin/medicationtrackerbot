package workout

import (
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// ErrScheduleInPast is returned by SchedulePlannedAdHocSession when the
// requested moment is at-or-before the current time in the user's timezone.
// HTTP callers map this to 400 Bad Request; other errors should be 500.
var ErrScheduleInPast = errors.New("scheduled time must be in the future")

// ErrScheduleBadTime is returned by SchedulePlannedAdHocSession when the
// scheduled_time string does not match strict 24-hour HH:MM form.
var ErrScheduleBadTime = errors.New("scheduled_time must be HH:MM (24h)")

// WorkoutStore is the narrow interface needed for compound workout operations.
type WorkoutStore interface {
	GetWorkoutSession(id int64) (*store.WorkoutSession, error)
	GetWorkoutGroup(groupID int64) (*store.WorkoutGroup, error)
	StartSession(id int64) error
	ClearSnooze(id int64) error
	SnoozeSession(id int64, duration time.Duration) error
	SkipSession(id int64) error
	CompleteSession(id int64) error
	AdvanceRotation(groupID int64) error
	CreateAdHocWorkoutSession(userID int64, scheduledDate time.Time, scheduledTime string) (*store.WorkoutSession, error)
	CreatePlannedAdHocSession(userID int64, scheduledDate time.Time, scheduledTime string) (*store.WorkoutSession, error)
	LogExerciseWithSource(sessionID, exerciseID int64, exerciseName string, setsCompleted, repsCompleted *int, weightKg *float64, status, notes, source string) (int64, error)
	DeleteSession(id int64) error
	GetCurrentTimezone() (string, error)
}

// PlannedExercise describes one item in a scheduled ad-hoc workout. Targets
// are sent so the agent can reflect intent in the request and so future code
// (notification body, UI prefill) can use them; only ExerciseID and
// ExerciseName are persisted as the placeholder workout_exercise_logs row.
type PlannedExercise struct {
	ExerciseID     int64
	ExerciseName   string
	TargetSets     int
	TargetRepsMin  int
	TargetRepsMax  *int
	TargetWeightKg *float64
}

// WorkoutService defines compound workout operations — the single source of truth
// handling operations that span multiple store calls.
type WorkoutService interface {
	// StartSession marks a session as in-progress and clears any active snooze.
	StartSession(sessionID int64) error
	// SnoozeSession defers a session reminder by the given duration.
	SnoozeSession(sessionID int64, duration time.Duration) error
	// SkipSession marks a session as skipped and advances the rotation for rotating groups.
	SkipSession(sessionID int64) error
	// CompleteSession marks a session as completed and advances the rotation for rotating groups.
	CompleteSession(sessionID int64) error
	// CreateAdHocSession creates a new ad-hoc (unscheduled) workout session already in progress.
	CreateAdHocSession(userID int64, now time.Time, scheduledTime string) (*store.WorkoutSession, error)
	// SchedulePlannedAdHocSession creates a future ad-hoc session in 'pending' state
	// with one placeholder exercise log row per planned exercise.
	SchedulePlannedAdHocSession(userID int64, scheduledDate time.Time, scheduledTime string, exercises []PlannedExercise) (*store.WorkoutSession, error)
}

// Service implements WorkoutService using a WorkoutStore.
type Service struct {
	store WorkoutStore
	// Now returns the current time. Defaults to time.Now; tests inject a fixed clock.
	Now func() time.Time
}

// New creates a new workout Service.
func New(s WorkoutStore) *Service {
	return &Service{store: s, Now: time.Now}
}

// StartSession marks a session as in-progress and clears any active snooze.
func (s *Service) StartSession(sessionID int64) error {
	if err := s.store.StartSession(sessionID); err != nil {
		return err
	}
	return s.store.ClearSnooze(sessionID)
}

// SnoozeSession defers a session reminder by the given duration.
func (s *Service) SnoozeSession(sessionID int64, duration time.Duration) error {
	return s.store.SnoozeSession(sessionID, duration)
}

// SkipSession marks a session as skipped and advances the rotation for rotating groups.
func (s *Service) SkipSession(sessionID int64) error {
	session, err := s.store.GetWorkoutSession(sessionID)
	if err != nil {
		return err
	}
	if err := s.store.SkipSession(sessionID); err != nil {
		return err
	}
	s.tryAdvanceRotation(session)
	return nil
}

// CompleteSession marks a session as completed and advances the rotation for rotating groups.
func (s *Service) CompleteSession(sessionID int64) error {
	session, err := s.store.GetWorkoutSession(sessionID)
	if err != nil {
		return err
	}
	if err := s.store.CompleteSession(sessionID); err != nil {
		return err
	}
	s.tryAdvanceRotation(session)
	return nil
}

// CreateAdHocSession creates a new ad-hoc (unscheduled) workout session already in progress.
func (s *Service) CreateAdHocSession(userID int64, now time.Time, scheduledTime string) (*store.WorkoutSession, error) {
	return s.store.CreateAdHocWorkoutSession(userID, now, scheduledTime)
}

// SchedulePlannedAdHocSession creates a future ad-hoc workout session and pre-creates
// a placeholder workout_exercise_logs row per planned exercise. The scheduled moment
// (scheduledDate's calendar day at scheduledTime, interpreted in the user's stored
// timezone — UTC if none is set) must be strictly in the future. Placeholder logs
// have status="" and NULL completion fields so the existing
// workouts.sessions.logs.update flow can fill them in at workout time.
func (s *Service) SchedulePlannedAdHocSession(userID int64, scheduledDate time.Time, scheduledTime string, exercises []PlannedExercise) (*store.WorkoutSession, error) {
	hh, mm, err := parseHHMM(scheduledTime)
	if err != nil {
		return nil, err
	}

	loc := time.UTC
	if tz, tzErr := s.store.GetCurrentTimezone(); tzErr != nil {
		slog.Warn("workout service: failed to load user timezone, falling back to UTC", "error", tzErr)
	} else if tz != "" {
		if l, locErr := time.LoadLocation(tz); locErr != nil {
			slog.Warn("workout service: invalid user timezone, falling back to UTC", "tz", tz, "error", locErr)
		} else {
			loc = l
		}
	}

	planned := time.Date(scheduledDate.Year(), scheduledDate.Month(), scheduledDate.Day(), hh, mm, 0, 0, loc)
	if !planned.After(s.Now()) {
		return nil, ErrScheduleInPast
	}

	session, err := s.store.CreatePlannedAdHocSession(userID, scheduledDate, scheduledTime)
	if err != nil {
		return nil, err
	}

	for _, ex := range exercises {
		source := "library"
		if ex.ExerciseID <= 0 {
			source = "schedule"
		}
		if _, err := s.store.LogExerciseWithSource(session.ID, ex.ExerciseID, ex.ExerciseName, nil, nil, nil, "", "", source); err != nil {
			// Roll back the just-created session so we don't leave an orphan
			// row whose placeholders are missing or partial. DeleteSession
			// also removes any prior placeholder logs for the session — FK
			// cascade is not active in this SQLite driver.
			if delErr := s.store.DeleteSession(session.ID); delErr != nil {
				slog.Error("workout service: failed to roll back orphan session after placeholder error", "session_id", session.ID, "error", delErr)
			}
			return nil, fmt.Errorf("create placeholder log for %q: %w", ex.ExerciseName, err)
		}
	}

	return session, nil
}

// parseHHMM parses a 24-hour HH:MM string into separate hour/minute integers.
// Requires exactly the 5-character HH:MM form so callers don't sneak through
// values like "7:30" or "07:30:00".
func parseHHMM(s string) (int, int, error) {
	if len(s) != 5 || s[2] != ':' {
		return 0, 0, ErrScheduleBadTime
	}
	t, err := time.Parse("15:04", s)
	if err != nil {
		return 0, 0, ErrScheduleBadTime
	}
	return t.Hour(), t.Minute(), nil
}

// tryAdvanceRotation performs best-effort rotation advancement after a successful
// terminal state transition. The primary transition should not fail if this step fails.
func (s *Service) tryAdvanceRotation(session *store.WorkoutSession) {
	if session == nil {
		return
	}

	group, err := s.store.GetWorkoutGroup(session.GroupID)
	if err != nil {
		slog.Error("workout service: failed to load group for session", "groupID", session.GroupID, "sessionID", session.ID, "error", err)
		return
	}
	if group == nil || !group.IsRotating {
		return
	}

	if err := s.store.AdvanceRotation(group.ID); err != nil {
		slog.Error("workout service: failed to advance rotation", "groupID", group.ID, "error", err)
	}
}
