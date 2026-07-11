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
	GetSession(id int64) (*store.WorkoutSession, error)
	GetGroup(groupID int64) (*store.WorkoutGroup, error)
	StartSession(id int64) error
	ClearSnooze(id int64) error
	SnoozeSession(id int64, duration time.Duration) error
	SkipSession(id int64) error
	CompleteSession(id int64) error
	UpdateSessionStatus(id int64, status string) error
	PreSkipSession(id int64) error
	CancelPreSkip(id int64) error
	AdvanceRotation(groupID int64) error
	CreateAdHocSession(userID int64, scheduledDate time.Time, scheduledTime string) (*store.WorkoutSession, error)
	CreatePlannedAdHocSession(userID int64, scheduledDate time.Time, scheduledTime string) (*store.WorkoutSession, error)
	LogExerciseWithSource(sessionID, exerciseID int64, exerciseName string, setsCompleted, repsCompleted *int, weightKg *float64, status, notes, source string) (int64, error)
	DeleteSession(id int64) error

	// Read methods used by GetNext's scheduling engine and the session read models.
	ListHistory(userID int64, limit int) ([]store.WorkoutSession, error)
	ListActiveSessions(userID int64, date time.Time) ([]store.WorkoutSession, error)
	ListSnoozedSessions(userID int64) ([]store.WorkoutSession, error)
	ListGroups(userID int64, activeOnly bool) ([]store.WorkoutGroup, error)
	ListVariantsByGroup(groupID int64) ([]store.WorkoutVariant, error)
	GetVariant(id int64) (*store.WorkoutVariant, error)
	ListExercisesByVariant(variantID int64) ([]store.WorkoutExercise, error)
	ListExerciseLogs(sessionID int64) ([]store.WorkoutExerciseLog, error)
	GetRotationState(groupID int64) (*store.WorkoutRotationState, error)
	GetSessionByGroupAndDate(groupID int64, scheduledDate time.Time) (*store.WorkoutSession, error)
	CreateSession(groupID, variantID, userID int64, scheduledDate time.Time, scheduledTime string) (*store.WorkoutSession, error)

	// Read/write methods used by the stats + rotation read models.
	ListExerciseStats(userID int64) ([]store.ExerciseStat, error)
	InitializeRotation(groupID, startingVariantID int64) error

	// Methods used by the exercise-log write models (UpdateExerciseLog /
	// AddExerciseToSession).
	UpdateExerciseLog(id int64, setsCompleted, repsCompleted *int, weightKg *float64, notes string) error
	UpdateExerciseLogStatus(id int64, status string) error
	GetExerciseLogByID(id int64) (*store.WorkoutExerciseLog, error)
	PropagateExerciseToSchedule(sessionID, exerciseID int64, exerciseName string, sets, reps *int, weight *float64) error
}

// TZStore is the timezone lookup the workout service needs.
type TZStore interface {
	GetCurrent() (string, error)
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
	// GetNext resolves the single next workout to surface to the user via the
	// 3-priority scheduling engine (active-today → snoozed → pending). Returns
	// (nil, nil) when there is no upcoming workout.
	GetNext(userID int64) (*NextWorkout, error)
	// ListSessions returns the user's recent workout sessions (newest first, up to
	// limit) enriched with group/variant names and per-session exercise counts.
	ListSessions(userID int64, limit int) ([]SessionView, error)
	// GetSessionDetails returns a single session with its exercise logs. Returns
	// (nil, nil) when the session does not exist.
	GetSessionDetails(sessionID int64) (*SessionDetails, error)
	// GetStats returns the user's 30-day session counts, completion rate, a
	// 12-week activity heatmap, and top exercises by aggregate volume.
	GetStats(userID int64) (*Stats, error)
	// GetRotationState returns a group's rotation state, or (nil, nil) when none
	// exists / it cannot be read (the handler maps that to 404).
	GetRotationState(groupID int64) (*store.WorkoutRotationState, error)
	// InitializeRotation sets a group's rotation to begin at startingVariantID.
	InitializeRotation(groupID, startingVariantID int64) error
	// SetSessionStatus applies a status transition (in_progress / completed /
	// skipped), advancing the rotation for terminal states on rotating groups.
	// Returns an Outcome telling the transport whether to run notification
	// cleanup, or (nil, nil) when the session does not exist.
	SetSessionStatus(sessionID int64, status string) (*Outcome, error)
	// PreSkipSession marks a session as pre-skipped (a reversible "about to skip"
	// state used by the bot reminder flow).
	PreSkipSession(sessionID int64) error
	// CancelPreSkipSession reverts a pre-skipped session back to pending.
	CancelPreSkipSession(sessionID int64) error
	// NextVariant advances a rotating group's rotation and deletes the current
	// (not-yet-started) session so the next variant is surfaced.
	NextVariant(sessionID int64) error
	// UpdateExerciseLog validates and applies an exercise-log edit, propagating
	// non-zero values back to the schedule and auto-promoting placeholder logs.
	UpdateExerciseLog(id int64, setsCompleted, repsCompleted *int, weightKg *float64, notes, status string) error
	// AddExerciseToSession logs a new exercise against a session (ownership is
	// verified by the transport layer) and propagates non-library targets back
	// to the schedule, returning the new log id.
	AddExerciseToSession(sessionID, exerciseID int64, exerciseName string, targetSets, targetRepsMin int, targetWeightKg *float64, status, notes, source string) (int64, error)
}

// Service implements WorkoutService using a WorkoutStore.
type Service struct {
	store WorkoutStore
	tz    TZStore
	// Now returns the current time. Defaults to time.Now; tests inject a fixed clock.
	Now func() time.Time
}

// New creates a new workout Service. tz may be nil — when nil
// SchedulePlannedAdHocSession falls back to UTC.
func New(s WorkoutStore, tz TZStore) *Service {
	return &Service{store: s, tz: tz, Now: time.Now}
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
	session, err := s.store.GetSession(sessionID)
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
	session, err := s.store.GetSession(sessionID)
	if err != nil {
		return err
	}
	if err := s.store.CompleteSession(sessionID); err != nil {
		return err
	}
	s.tryAdvanceRotation(session)
	return nil
}

// CreateAdHocSession creates a new ad-hoc (unscheduled) workout session already in
// progress. At most one active session may exist at a time: if the user already has
// an active session for `now`'s calendar day (notified / in_progress / pre_skipped),
// it is resumed rather than duplicated. This matches next.go's PRIORITY-0 resume
// semantics and preserves the ≤1-active-session invariant the scheduling engine
// assumes; the guard lives here so bot, HTTP, and MCP callers all inherit it.
func (s *Service) CreateAdHocSession(userID int64, now time.Time, scheduledTime string) (*store.WorkoutSession, error) {
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	if active, err := s.store.ListActiveSessions(userID, today); err == nil && len(active) > 0 {
		slog.Info("workout service: resuming existing active session instead of creating ad-hoc duplicate", "user_id", userID, "session_id", active[0].ID)
		return &active[0], nil
	}
	return s.store.CreateAdHocSession(userID, now, scheduledTime)
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
	if s.tz != nil {
		if tz, tzErr := s.tz.GetCurrent(); tzErr != nil {
			slog.Warn("workout service: failed to load user timezone, falling back to UTC", "error", tzErr)
		} else if tz != "" {
			if l, locErr := time.LoadLocation(tz); locErr != nil {
				slog.Warn("workout service: invalid user timezone, falling back to UTC", "tz", tz, "error", locErr)
			} else {
				loc = l
			}
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

	group, err := s.store.GetGroup(session.GroupID)
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
