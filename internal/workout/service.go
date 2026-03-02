package workout

import (
	"context"
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
	StartSession(ctx context.Context, sessionID int64) error
	// SnoozeSession defers a session reminder by the given duration.
	SnoozeSession(ctx context.Context, sessionID int64, duration time.Duration) error
	// SkipSession marks a session as skipped and advances the rotation for rotating groups.
	SkipSession(ctx context.Context, sessionID int64) error
	// CompleteSession marks a session as completed and advances the rotation for rotating groups.
	CompleteSession(ctx context.Context, sessionID int64) error
	// CreateAdHocSession creates a new ad-hoc (unscheduled) workout session already in progress.
	CreateAdHocSession(ctx context.Context, userID int64, now time.Time, scheduledTime string) (*store.WorkoutSession, error)
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
func (s *Service) StartSession(_ context.Context, sessionID int64) error {
	if err := s.store.StartSession(sessionID); err != nil {
		return err
	}
	return s.store.ClearSnooze(sessionID)
}

// SnoozeSession defers a session reminder by the given duration.
func (s *Service) SnoozeSession(_ context.Context, sessionID int64, duration time.Duration) error {
	return s.store.SnoozeSession(sessionID, duration)
}

// SkipSession marks a session as skipped and advances the rotation for rotating groups.
func (s *Service) SkipSession(_ context.Context, sessionID int64) error {
	session, err := s.store.GetWorkoutSession(sessionID)
	if err != nil {
		return err
	}
	if err := s.store.SkipSession(sessionID); err != nil {
		return err
	}
	if session != nil {
		group, err := s.store.GetWorkoutGroup(session.GroupID)
		if err == nil && group != nil && group.IsRotating {
			if err := s.store.AdvanceRotation(group.ID); err != nil {
				return err
			}
		}
	}
	return nil
}

// CompleteSession marks a session as completed and advances the rotation for rotating groups.
func (s *Service) CompleteSession(_ context.Context, sessionID int64) error {
	session, err := s.store.GetWorkoutSession(sessionID)
	if err != nil {
		return err
	}
	if err := s.store.CompleteSession(sessionID); err != nil {
		return err
	}
	if session != nil {
		group, err := s.store.GetWorkoutGroup(session.GroupID)
		if err == nil && group != nil && group.IsRotating {
			if err := s.store.AdvanceRotation(group.ID); err != nil {
				return err
			}
		}
	}
	return nil
}

// CreateAdHocSession creates a new ad-hoc (unscheduled) workout session already in progress.
func (s *Service) CreateAdHocSession(_ context.Context, userID int64, now time.Time, scheduledTime string) (*store.WorkoutSession, error) {
	return s.store.CreateAdHocWorkoutSession(userID, now, scheduledTime)
}
