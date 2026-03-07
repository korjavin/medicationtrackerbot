package workout

import (
	"log"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

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
}

// WorkoutService defines compound workout operations — the single source of truth
// for operations that span multiple store calls.
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
}

// Service implements WorkoutService using a WorkoutStore.
type Service struct {
	store WorkoutStore
}

// New creates a new workout Service.
func New(s WorkoutStore) *Service {
	return &Service{store: s}
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

// tryAdvanceRotation performs best-effort rotation advancement after a successful
// terminal state transition. The primary transition should not fail if this step fails.
func (s *Service) tryAdvanceRotation(session *store.WorkoutSession) {
	if session == nil {
		return
	}

	group, err := s.store.GetWorkoutGroup(session.GroupID)
	if err != nil {
		log.Printf("workout service: failed to load group %d for session %d: %v", session.GroupID, session.ID, err)
		return
	}
	if group == nil || !group.IsRotating {
		return
	}

	if err := s.store.AdvanceRotation(group.ID); err != nil {
		log.Printf("workout service: failed to advance rotation for group %d: %v", group.ID, err)
	}
}
